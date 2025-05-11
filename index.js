/* ===============================
 * 📁 node/whatsapp-bridge/index.js
 * =============================== */

const express          = require('express');
const cors             = require('cors');
const qrcode           = require('qrcode');
const fs               = require('fs-extra');
const P                = require('pino');
const qrcodeTerminal   = require('qrcode-terminal');
const axios            = require('axios');

const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} = require('@whiskeysockets/baileys');

/* ---------- CONFIG ---------- */
const PORT        = 3000;
const SESSION_DIR = './sessions';           // <-- nom uniforme
fs.ensureDirSync(SESSION_DIR);

const app = express();
app.use(cors());
app.use(express.json());

/* ---------- ÉTATS EN MÉMOIRE ---------- */
const clients         = {};   // id → socket Baileys
const qrCodes         = {};   // id → data-url QR
const clientSessions  = {};   // numéro → { ecomId, produitId }

/* ---------- CONNEXION / RECONNEXION ---------- */
async function startSock(ecommercantId) {
  const { state, saveCreds } =
    await useMultiFileAuthState(`${SESSION_DIR}/${ecommercantId}`);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: P({ level: 'silent' }),
    auth: state,
    printQRInTerminal: false,
  });

  /* --- événements connexion --- */
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrCodes[ecommercantId] = await qrcode.toDataURL(qr);
      console.log(`📲 QR généré pour ecommercant ${ecommercantId}`);
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === 'open') {
      console.log(`✅ WhatsApp connecté pour ecommercant ${ecommercantId}`);
    }

    if (connection === 'close') {
      const erreurCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = erreurCode !== DisconnectReason.loggedOut;
      console.log(`🔁 Déconnecté de ${ecommercantId}. Reconnexion ?`, shouldReconnect);
      if (shouldReconnect) startSock(ecommercantId);
    }
  });

  /* --- réception de messages --- */
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const numeroClient = msg.key.remoteJid.split('@')[0];
    const contenu =
      msg.message.conversation || msg.message.extendedTextMessage?.text;

    console.log('📩 Message reçu WhatsApp:', contenu);

    /* ----- 1) Cas IA-AUTO (lien annonce) ----- */
    if (contenu && contenu.startsWith('IA-AUTO:')) {
      const [ecomId, produitId] = contenu.split(':')[1].split('-');
      clientSessions[numeroClient] = { ecomId, produitId };
      console.log('🔗 Session enregistrée localement:', clientSessions[numeroClient]);

      /* sauvegarde BDD */
      try {
        await axios.post(
          'http://localhost:8080/api/session/save',
          {
            numero_client: numeroClient,
            ecommercant_id: ecomId,
            produit_id: produitId,
          },
          { headers: { 'Content-Type': 'application/json' } }
        );
        console.log('✅ Session enregistrée en BDD !');
      } catch (err) {
        console.error('❌ Erreur enregistrement session:', err.message);
      }

      /* réponse IA automatique */
      try {
        const { data } = await axios.post(
          'http://localhost:8080/api/ia/generer-reponse',
          {
            ecommercant_id: ecomId,
            produit_id: produitId,
            numero_client: numeroClient,
          }
        );
        await sock.sendMessage(msg.key.remoteJid, { text: data.reponse });
        console.log('✅ Réponse IA envoyée (auto)');
      } catch (err) {
        console.error('❌ Erreur API IA :', err.message);
      }
      return;                                     // ← rien d’autre à faire
    }

    /* ----- 2) Cas conversation normale ----- */
    let session = clientSessions[numeroClient];
    console.log('📌 Session mémoire:', session);

    /* si absente → tentative BDD */
    if (!session) {
      console.log('🔍 Session non trouvée, recherche BDD…');
      try {
        const { data } = await axios.get(
          `http://localhost:8080/api/session/find?numero_client=${numeroClient}`
        );
        session = {
          ecomId: data.ecommercant_id,
          produitId: data.produit_id,
        };
        clientSessions[numeroClient] = session;
        console.log('✅ Session trouvée en BDD:', session);
      } catch (err) {
        console.error('❌ Pas de session trouvée :', err.message);
      }
    }

    /* ---- si session valide → appel IA ---- */
    if (session?.ecomId && session?.produitId) {
      try {
        const { data } = await axios.post(
          'http://localhost:8080/api/ia/chat',
          {
            ecommercant_id: session.ecomId,
            produit_id: session.produitId,
            message_client: contenu,
          }
        );
        await sock.sendMessage(msg.key.remoteJid, { text: data.reponse });
        console.log('✅ Réponse IA envoyée (chat)');
      } catch (err) {
        console.error('❌ Erreur API chat IA :', err.message);
      }
    } else {
      await sock.sendMessage(msg.key.remoteJid, {
        text:
          '👋 Bonjour ! Pour commencer, cliquez d’abord sur un lien d’annonce ' +
          'afin d’associer votre demande à un produit.',
      });
      console.log('⚠️ Aucune session valide pour ce client.');
    }
  });

  /* --- référence socket --- */
  clients[ecommercantId] = sock;
}

/* ---------- ENDPOINTS HTTP ---------- */
app.get('/connect/:id', async (req, res) => {
  const id = req.params.id;

 if (clients[id] && clients[id].ws && clients[id].ws.readyState === 1) { // 1 == OPEN
   return res.send(`✅ Session WhatsApp déjà active pour ecommercant ${id}`);
 }

  await startSock(id);
  res.send(`QR généré pour ecommercant ${id}`);
});

/* renvoie { connected : true|false } */
app.get('/whatsapp/connected/:id', (req,res)=>{
  const id = req.params.id;
  const ok = !!clients[id] && !!clients[id].user;   // socket actif
  res.json({ connected : ok });
});


app.get('/whatsapp/qr/:id', (req, res) => {
  const id = req.params.id;
  const qr = qrCodes[id];
  if (!qr) {
    return res.status(404).send('QR code non prêt pour cet ecommercant.');
  }

  res.send(`
    <html>
      <body>
        <h2>QR WhatsApp pour ecommercant ${id}</h2>
        <img src="${qr}" alt="QR Code WhatsApp"/>
      </body>
    </html>
  `);
});

app.post('/whatsapp/send', async (req, res) => {
  const { ecommercant_id, phone, message } = req.body;
  console.log('🟡 Requête d’envoi :', req.body);

  const sock = clients[ecommercant_id];
  if (!sock) {
    return res.status(500).send('Session WhatsApp non active');
  }

  try {
    let jid = phone;
    if (!phone.endsWith('@s.whatsapp.net')) {
      jid = phone.startsWith('+')
        ? phone.slice(1) + '@s.whatsapp.net'
        : `212${phone.replace(/^0/, '')}@s.whatsapp.net`;
    }

    console.log(`🕐 Envoi vers ${jid}`);
    await sock.sendMessage(jid, { text: message });
    console.log(`✅ Message envoyé à ${jid}`);
    res.send({ success: true, message: '✅ Message envoyé' });
  } catch (err) {
    console.error('❌ Erreur d’envoi :', err);
    res.status(408).send(
      '❌ WhatsApp timeout — numéro peut-être invalide ou déconnecté'
    );
  }
});

/*---------  DELETE -------------*/

app.delete('/whatsapp/:id', async (req, res) => {
  const id = req.params.id;
  const sock = clients[id];
  if (!sock) {
    return res.status(404).json({ error: 'Aucune session active pour cet id' });
  }

  try {
    // 1) logout proprement
    await sock.logout();
    // 2) supprime de la mémoire
    delete clients[id];
    delete qrCodes[id];
    // (optionnel) supprime le dossier de session sur le disque
    await fs.remove(`${SESSION_DIR}/${id}`);

    console.log(`❎ WhatsApp déconnecté pour ecommercant ${id}`);
    return res.json({ success: true, message: 'Session déconnectée' });
  } catch (err) {
    console.error('❌ Erreur lors de la déconnexion:', err);
    return res.status(500).json({ error: err.message });
  }
});

/* ---------- DÉMARRAGE ---------- */
app.listen(PORT, () => {
  console.log(
    `🚀 Bridge WhatsApp multi-sessions actif : http://localhost:${PORT}`
  );
});

/* ---------- RECHARGE AUTOMATIQUE DES SESSIONS ---------- */
async function reconnectAllSessions() {
  const folders = fs
    .readdirSync(SESSION_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  console.log(`🔄 Sessions trouvées : ${folders.join(', ')}`);

  for (const folder of folders) {
    console.log(`⏳ Reconnexion automatique pour ecommercant ${folder}…`);
    await startSock(folder);
  }
}
reconnectAllSessions();

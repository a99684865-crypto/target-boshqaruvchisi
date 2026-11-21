const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// public papkasidagi yoki ildizdagi index.html faylini ochish
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// =========================================================================
// 1. MONGODB ATLAS ULANISHI VA BAZA MODELI
// =========================================================================
if (process.env.MONGO_URI) {
  mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('MongoDB Atlas muvaffaqiyatli ulandi'))
    .catch(err => console.error('MongoDB ulanish xatosi:', err));
} else {
  console.warn('OGOHLANTIRISH: MONGO_URI kiritilmagan!');
}

const LeadSchema = new mongoose.Schema({
  igId: { type: String, unique: true, sparse: true },
  name: { type: String, required: true },
  username: String,
  account: { type: String, default: '@toylarga.taklfinoma' },
  status: { type: String, default: 'new' },
  priority: { type: String, default: 'medium' },
  assignee: { type: String, default: 'Asosiy Menejer' },
  phone: String,
  service: String,
  amount: { type: Number, default: 0 },
  eventDate: String,
  paymentStatus: { type: String, default: 'unpaid' },
  followUp: String,
  adCampaign: String,
  notes: String,
  unread: { type: Boolean, default: true },
  messages: [
    {
      sender: String, // 'user' | 'admin' | 'ai' | 'internal'
      text: String,
      time: String,
      internal: { type: Boolean, default: false }
    }
  ]
}, { timestamps: true });

const Lead = mongoose.model('Lead', LeadSchema);

// =========================================================================
// 2. META INSTAGRAM WEBHOOK TEKSHIRUVI (GET)
// =========================================================================
app.get('/webhook/instagram', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    console.log('Instagram Webhook muvaffaqiyatli tasdiqlandi!');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// =========================================================================
// 3. INSTAGRAM DIRECT'DAN YANGI XABAR KELGANDA (POST)
// =========================================================================
app.post('/webhook/instagram', async (req, res) => {
  // Meta serveriga darhol 200 OK qaytarish shart
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const recipientPageId = entry?.id;
    const event = entry?.messaging?.[0];

    // Echo (o'zimiz yuborgan) yoki bo'sh xabarlarni o'tkazib yuborish
    if (!event || !event.message || event.message.is_echo) return;

    const senderId = event.sender.id;
    const userText = event.message.text || '[Media / Stiker yuborildi]';
    const timeNow = new Date().toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit' });

    // Qaysi Instagram sahifaga yozilganini aniqlash
    const accountName = recipientPageId === process.env.META_PAGE_ID_2
      ? '@toyga.taklifnoma'
      : '@toylarga.taklfinoma';

    let lead = await Lead.findOne({ igId: senderId });

    // Agar yangi mijoz bo'lsa, Instagram Graph API'dan ismini olishga harakat qilamiz
    if (!lead) {
      let profileName = 'Instagram Mijoz #' + senderId.slice(-4);
      let profileUsername = 'ig_' + senderId.slice(-5);

      const token = getPageToken(accountName);
      if (token) {
        try {
          const userRes = await fetch(`https://graph.facebook.com/v21.0/${senderId}?fields=name,username&access_token=${token}`);
          const userData = await userRes.json();
          if (userData.name) profileName = userData.name;
          if (userData.username) profileUsername = userData.username;
        } catch (e) {}
      }

      lead = await Lead.create({
        igId: senderId,
        name: profileName,
        username: profileUsername,
        account: accountName,
        adCampaign: 'Instagram Direct / Target',
        messages: []
      });
    }

    lead.unread = true;
    lead.messages.push({ sender: 'user', text: userText, time: timeNow });
    await lead.save();

    // Telegram botga darhol bildirishnoma yuborish
    if (process.env.TG_BOT_TOKEN && process.env.TG_CHAT_ID) {
      fetch(`https://api.telegram.org/bot${process.env.TG_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: process.env.TG_CHAT_ID,
          text: `📩 Yangi xabar (${accountName})!\n👤 Mijoz: ${lead.name} (@${lead.username})\n💬 Xabar: ${userText}`
        })
      }).catch(() => {});
    }

    // Agar GEMINI_API_KEY ulangan bo'lsa, AI menejer javob qaytaradi
    if (process.env.GEMINI_API_KEY && process.env.AUTO_REPLY !== 'false') {
      const history = lead.messages
        .filter(m => !m.internal)
        .map(m => `${m.sender === 'user' ? 'Mijoz' : 'Menejer'}: ${m.text}`)
        .join('\n');

      const prompt = `Sen ${accountName} sahifasining tirik o'zbek sotuvchi menejerisan. Xuddi telefonda Instagram Direct'dan yozayotgan samimiy odamdek 1-2 ta qisqa gap bilan javob yoz. Robotga o'xshama.
Suhbat:
${history}`;

      const aiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7 }
        })
      });

      const aiData = await aiRes.json();
      const replyText = aiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

      if (replyText) {
        await sendInstagramDM(senderId, replyText, accountName);
        lead.messages.push({ sender: 'ai', text: replyText, time: timeNow });
        await lead.save();
      }
    }
  } catch (error) {
    console.error('Webhook ishlashida xatolik:', error);
  }
});

// =========================================================================
// 4. INSTAGRAM GRAPH API ORQALI XABAR YUBORISH YORDAMCHI FUNKSIYALARI
// =========================================================================
function getPageToken(accountName) {
  if (accountName === '@toyga.taklifnoma') {
    return process.env.META_TOKEN_2 || process.env.META_PAGE_TOKEN;
  }
  return process.env.META_TOKEN_1 || process.env.META_PAGE_TOKEN;
}

async function sendInstagramDM(recipientId, text, accountName) {
  const token = getPageToken(accountName);
  if (!token || !recipientId) return;

  const response = await fetch(`https://graph.facebook.com/v21.0/me/messages?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error('Instagram DM yuborishda xato:', errText);
  }
}

// =========================================================================
// 5. CRM FRONTEND API YO'LLARI (CRUD)
// =========================================================================
app.get('/api/leads', async (req, res) => {
  try {
    const leads = await Lead.find().sort({ updatedAt: -1 });
    res.json(leads);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/leads', async (req, res) => {
  try {
    const lead = await Lead.create(req.body);
    res.json(lead);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/leads/:id', async (req, res) => {
  try {
    const updated = await Lead.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/leads/:id', async (req, res) => {
  try {
    await Lead.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/send-message', async (req, res) => {
  try {
    const { leadId, igId, text, internal } = req.body;
    const timeNow = new Date().toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit' });

    const existing = await Lead.findById(leadId);
    if (!existing) return res.status(404).json({ error: 'Mijoz topilmadi' });

    // Agar ichki eslatma bo'lmasa va Instagram ID bor bo'lsa, haqiqiy Instagram Direct'ga yuboradi
    if (!internal && (igId || existing.igId)) {
      await sendInstagramDM(igId || existing.igId, text, existing.account);
    }

    existing.messages.push({
      sender: internal ? 'internal' : 'admin',
      text,
      time: timeNow,
      internal: Boolean(internal)
    });

    if (!internal && existing.status === 'new') {
      existing.status = 'talking';
    }

    await existing.save();
    res.json(existing);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Asosiy sahifani qaytarish
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`InstaCRM Server ${PORT}-portda ishga tushdi`));
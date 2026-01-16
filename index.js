const express = require('express');
const line = require('@line/bot-sdk');
const { google } = require('googleapis');

/* ======================
   Google Sheets (FIXED)
====================== */
const auth = new google.auth.JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

async function saveCheckinToSheet({ date, userId, name, workType }) {
  try {
    // 🔑 สำคัญมาก: ต้อง authorize ก่อน
    await auth.authorize();

    const sheets = google.sheets({
      version: 'v4',
      auth,
    });

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: 'checkin!A:E',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          date,
          userId,
          name,
          workType,
          new Date().toLocaleString('th-TH'),
        ]],
      },
    });
  } catch (err) {
    console.error('❌ GOOGLE SHEET ERROR');
    console.error(err.response?.data || err.message);
    throw err;
  }
}

/* ======================
   Express + LINE
====================== */
const app = express();

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.Client(config);

/* ======================
   Memory
====================== */
const checkinStore = {};
const employees = {
  'U9f3cd3d1de967058e10642695e305241': { name: 'Nat', active: true },
};

/* ======================
   Helpers
====================== */
function getToday() {
  return new Date().toISOString().split('T')[0];
}
function isSunday() {
  return new Date().getDay() === 0;
}
function isAfter0930() {
  const d = new Date();
  return d.getHours() > 9 || (d.getHours() === 9 && d.getMinutes() >= 30);
}
function formatThaiDate() {
  const d = new Date();
  return `วันที่ ${d.getDate()}/${d.getMonth()+1}/${d.getFullYear()+543}`;
}

/* ======================
   Webhook
====================== */
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    for (const event of req.body.events) {
      if (event.type !== 'message' || event.message.type !== 'text') continue;

      const userId = event.source.userId;
      const text = event.message.text.trim().toLowerCase();
      const isAdmin = userId === process.env.ADMIN_USER_ID;

      const profile = await client.getProfile(userId);
      const name = profile.displayName;

      if (text === 'whoami') {
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: `👤 ${name}\n${isAdmin ? 'admin' : 'employee'}`,
        });
        continue;
      }

      if (text === 'checkin') {
        if (!isAdmin && !employees[userId]?.active)
          return client.replyMessage(event.replyToken,{ type:'text', text:'❌ คุณไม่ใช่ employee' });

        if (isSunday())
          return client.replyMessage(event.replyToken,{ type:'text', text:'❌ วันอาทิตย์ไม่ต้อง check-in' });

        if (isAfter0930() && !isAdmin)
          return client.replyMessage(event.replyToken,{ type:'text', text:'⛔ ระบบปิดแล้ว' });

        await client.replyMessage(event.replyToken, {
          type: 'template',
          altText: 'เลือกประเภทงาน',
          template: {
            type: 'buttons',
            text: `${formatThaiDate()}\n${name}`,
            actions: [
              { label: 'เต็มวัน', type: 'message', text: 'work:full' },
              { label: 'ครึ่งวันเช้า', type: 'message', text: 'work:half-morning' },
              { label: 'ครึ่งวันบ่าย', type: 'message', text: 'work:half-afternoon' },
              { label: 'หยุด', type: 'message', text: 'work:off' },
            ],
          },
        });
        continue;
      }

      if (text.startsWith('work:')) {
        try {
          await saveCheckinToSheet({
            date: getToday(),
            userId,
            name,
            workType: text,
          });

          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: `✅ บันทึกสำเร็จ\n${name}`,
          });
        } catch (err) {
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: `⚠️ บันทึกไม่สำเร็จ (Google Sheet)\n${err.response?.data?.error?.message || err.message}`,
          });
        }
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error('WEBHOOK ERROR', e);
    res.sendStatus(500);
  }
});

/* ======================
   Health
====================== */
app.get('/', (_, res) => res.send('LINE Bot is running 🚀'));
app.get('/health', (_, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
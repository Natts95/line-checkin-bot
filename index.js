const express = require('express');
const line = require('@line/bot-sdk');
const cron = require('node-cron'); // ✅ เพิ่ม cron

const app = express();

/* ======================
   LINE config
====================== */
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.Client(config);

/* ======================
   Memory เก็บ check-in
====================== */
const checkinStore = {};

/* ======================
   Helper functions
====================== */
function getToday() {
  return new Date().toISOString().split('T')[0];
}

function isSunday() {
  return new Date().getDay() === 0;
}

function isAfter0930() {
  const now = new Date();
  return now.getHours() > 9 || (now.getHours() === 9 && now.getMinutes() >= 30);
}

function formatThaiDate() {
  const d = new Date();
  const days = ['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์','เสาร์'];
  const months = [
    'มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน',
    'กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'
  ];
  return `วัน${days[d.getDay()]}ที่ ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()+543}`;
}

function hasNotCheckedInToday(userId, today) {
  return !checkinStore[userId] || checkinStore[userId].date !== today;
}

/* ======================
   🔔 Auto Reminder
====================== */

// ⏰ 09:00 เตือนครั้งแรก
cron.schedule('0 9 * * *', async () => {
  if (isSunday()) return;

  const today = getToday();
  const thaiDate = formatThaiDate();

  for (const userId in checkinStore) {
    if (hasNotCheckedInToday(userId, today)) {
      try {
        const profile = await client.getProfile(userId);
        await client.pushMessage(userId, {
          type: 'text',
          text: `⏰ แจ้งเตือน 09:00\n${thaiDate}\n${profile.displayName} อย่าลืม check-in นะคะ`,
        });
      } catch (err) {
        console.error('09:00 reminder error:', err);
      }
    }
  }
}, { timezone: 'Asia/Bangkok' });

// ⚠️ 09:20 เตือนครั้งสุดท้าย
cron.schedule('20 9 * * *', async () => {
  if (isSunday()) return;

  const today = getToday();
  const thaiDate = formatThaiDate();

  for (const userId in checkinStore) {
    if (hasNotCheckedInToday(userId, today)) {
      try {
        const profile = await client.getProfile(userId);
        await client.pushMessage(userId, {
          type: 'text',
          text: `⚠️ แจ้งเตือนครั้งสุดท้าย (09:20)\n${thaiDate}\n${profile.displayName}\nระบบจะปิด check-in เวลา 09:30`,
        });
      } catch (err) {
        console.error('09:20 reminder error:', err);
      }
    }
  }
}, { timezone: 'Asia/Bangkok' });

/* ======================
   Root + Health
====================== */
app.get('/', (req, res) => res.send('LINE Bot is running 🚀'));
app.get('/health', (req, res) => res.send('OK'));

/* ======================
   LINE Webhook
====================== */
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    for (const event of req.body.events) {
      if (event.type !== 'message' || event.message.type !== 'text') continue;

      const userId = event.source.userId;
      const text = event.message.text.toLowerCase().trim();
      const today = getToday();
      const thaiDate = formatThaiDate();

      const profile = await client.getProfile(userId);
      const name = profile.displayName;

      /* ===== checkin ===== */
      if (text === 'checkin') {

        if (isSunday()) {
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: '❌ วันอาทิตย์ไม่ต้อง check-in ค่ะ',
          });
          continue;
        }

        if (isAfter0930()) {
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: `⛔ ${name} ระบบปิด check-in แล้ว (หลัง 09:30)`,
          });
          continue;
        }

        if (checkinStore[userId]?.date === today) {
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: `⚠️ ${name} วันนี้คุณบันทึกไปแล้ว`,
          });
          continue;
        }

        await client.replyMessage(event.replyToken, {
          type: 'template',
          altText: 'เลือกประเภทงาน',
          template: {
            type: 'buttons',
            text: `${thaiDate}\n${name} วันนี้คุณทำงานแบบไหนคะ`,
            actions: [
              { label: 'ทำงานเต็มวัน', type: 'message', text: 'work:full' },
              { label: 'ครึ่งวันเช้า', type: 'message', text: 'work:half-morning' },
              { label: 'ครึ่งวันบ่าย', type: 'message', text: 'work:half-afternoon' },
              { label: 'หยุดงาน', type: 'message', text: 'work:off' },
            ],
          },
        });
        continue;
      }

      /* ===== รับคำตอบ ===== */
      if (text.startsWith('work:')) {

        if (isAfter0930()) {
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: `⛔ ${name} ระบบปิด check-in แล้ว`,
          });
          continue;
        }

        if (checkinStore[userId]?.date === today) {
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: `⚠️ ${name} วันนี้คุณบันทึกไปแล้ว`,
          });
          continue;
        }

        const map = {
          'work:full': 'ทำงานเต็มวัน',
          'work:half-morning': 'ครึ่งวันเช้า',
          'work:half-afternoon': 'ครึ่งวันบ่าย',
          'work:off': 'หยุดงาน',
        };

        checkinStore[userId] = { date: today, workType: text };

        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: `✅ ทำการบันทึกการทำงาน\n${thaiDate}\nของ ${name}\n(${map[text]}) เรียบร้อยค่ะ`,
        });
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

/* ======================
   Start server
====================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

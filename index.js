const express = require('express');
const line = require('@line/bot-sdk');
const cron = require('node-cron');
const { google } = require('googleapis');

/* ======================
   Google Sheets Auth
====================== */
const auth = new google.auth.JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

/* ======================
   Memory Store
====================== */
const checkinStore = {};
const employees = {}; 
// structure: { userId: { name: String, active: Boolean } }

const admins = {};
// structure: { userId: { name: String, active: Boolean } }

/* ======================
   Google Sheets Functions
====================== */

// 1. Save Check-in
async function saveCheckinToSheet({ date, userId, name, workType }) {
  try {
    await auth.authorize();
    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: 'checkin!A:E',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[ date, userId, name, workType, new Date().toLocaleString('th-TH') ]],
      },
    });
    console.log(`📝 Check-in Saved: ${name}`);
  } catch (err) {
    console.error('❌ SAVE CHECKIN ERROR:', err.message);
    throw err;
  }
}

// 2. Save Employee Log
async function saveEmployeeToSheet({ userId, name, status, adminId }) {
  try {
    await auth.authorize();
    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: 'employee!A:E',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[ new Date().toLocaleString('th-TH'), userId, name, status, adminId ]],
      },
    });
    console.log(`📝 Employee Log: ${name} (${status})`);
  } catch (err) {
    console.error('❌ SAVE EMPLOYEE ERROR:', err.message);
  }
}

// 3. Save Admin Log (New!)
async function saveAdminToSheet({ userId, name, status, promotedBy }) {
  try {
    await auth.authorize();
    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: 'admin!A:E', // ต้องมี Tab ชื่อ admin
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[ new Date().toLocaleString('th-TH'), userId, name, status, promotedBy ]],
      },
    });
    console.log(`📝 Admin Log: ${name} (${status})`);
  } catch (err) {
    console.error('❌ SAVE ADMIN ERROR:', err.message);
  }
}

// 4. Load Data (Load ทั้ง Employee และ Admin)
async function loadDataFromSheet() {
  console.log('🔄 Loading data from Google Sheet...');
  try {
    await auth.authorize();
    const sheets = google.sheets({ version: 'v4', auth });

    // --- Load Employees ---
    const empRes = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: 'employee!A:E', 
    });
    if (empRes.data.values) {
      empRes.data.values.forEach((row) => {
        const [, userId, name, status] = row;
        if (!userId || userId.toLowerCase() === 'userid') return;
        if (status === 'active') employees[userId] = { name, active: true };
        else if (status === 'inactive' && employees[userId]) employees[userId].active = false;
      });
    }

    // --- Load Admins (New!) ---
    const adminRes = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: 'admin!A:E', 
    });
    if (adminRes.data.values) {
      adminRes.data.values.forEach((row) => {
        const [, userId, name, status] = row;
        if (!userId || userId.toLowerCase() === 'userid') return;
        if (status === 'active') admins[userId] = { name, active: true };
        else if (status === 'inactive' && admins[userId]) admins[userId].active = false;
      });
    }

    console.log(`✅ Loaded: ${Object.keys(employees).length} Employees, ${Object.keys(admins).length} Admins`);

  } catch (err) {
    console.error('❌ LOAD DATA ERROR:', err.message);
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
   Helpers
====================== */
function getToday() { return new Date().toISOString().split('T')[0]; }
function isSunday() { return new Date().getDay() === 0; }
function isAfter0930() { 
  const d = new Date(); 
  return d.getHours() > 9 || (d.getHours() === 9 && d.getMinutes() >= 30); 
}
function formatThaiDate() {
  const d = new Date();
  const days = ['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์','เสาร์'];
  const months = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
  return `วัน${days[d.getDay()]}ที่ ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear() + 543}`;
}

/* ======================
   Webhook
====================== */
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    for (const event of req.body.events) {
      if (event.type !== 'message' || event.message.type !== 'text') continue;

      const userId = event.source.userId;
      const text = event.message.text.trim();
      const lower = text.toLowerCase();
      const today = getToday();
      const thaiDate = formatThaiDate();

      // เช็คสิทธิ์ Admin: คือ Super Admin (ใน .env) หรือ คนที่มีชื่อในตาราง admins
      const isSuperAdmin = userId === process.env.ADMIN_USER_ID;
      const isAdmin = isSuperAdmin || admins[userId]?.active;

      const profile = await client.getProfile(userId);
      const name = profile.displayName;

      /* ===== whoami ===== */
      if (lower === 'whoami') {
        let role = 'Guest';
        if (isSuperAdmin) role = '👑 Super Admin';
        else if (isAdmin) role = '🛡️ Admin';
        else if (employees[userId]?.active) role = '💼 Employee';

        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: `👤 ${name}\nuserId:\n${userId}\nRole: ${role}`,
        });
        continue;
      }

      /* =========================================
         ZONE: จัดการ Employee
         ========================================= */
      
      /* -> ADD Employee */
      if (lower.startsWith('add employee')) {
        if (!isAdmin) {
          await client.replyMessage(event.replyToken, { type: 'text', text: '❌ Access Denied' });
          continue;
        }
        const [, , empId, ...parts] = text.split(' ');
        const empName = parts.join(' ') || 'Employee';
        if (!empId) {
          await client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ usage: add employee <userId> <name>' });
          continue;
        }

        employees[empId] = { name: empName, active: true };
        await saveEmployeeToSheet({ userId: empId, name: empName, status: 'active', adminId: userId });

        await client.replyMessage(event.replyToken, { type: 'text', text: `✅ Added Employee:\n${empName}` });
        continue;
      }

      /* -> REMOVE Employee */
      if (lower.startsWith('remove employee')) {
        if (!isAdmin) {
          await client.replyMessage(event.replyToken, { type: 'text', text: '❌ Access Denied' });
          continue;
        }
        const [, , empId] = text.split(' ');
        const targetName = employees[empId]?.name || 'Unknown';
        if (!employees[empId]) {
            await client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ Not found' });
            continue;
        }

        employees[empId].active = false;
        await saveEmployeeToSheet({ userId: empId, name: targetName, status: 'inactive', adminId: userId });

        await client.replyMessage(event.replyToken, { type: 'text', text: `⛔ Removed Employee:\n${targetName}` });
        continue;
      }

      /* =========================================
         ZONE: จัดการ Admin (ใหม่!)
         ========================================= */

      /* -> ADD Admin */
      if (lower.startsWith('add admin')) {
        if (!isAdmin) {
          await client.replyMessage(event.replyToken, { type: 'text', text: '❌ Access Denied' });
          continue;
        }
        const [, , admId, ...parts] = text.split(' ');
        const admName = parts.join(' ') || 'Admin';

        if (!admId) {
          await client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ usage: add admin <userId> <name>' });
          continue;
        }

        admins[admId] = { name: admName, active: true };
        await saveAdminToSheet({ userId: admId, name: admName, status: 'active', promotedBy: userId });

        await client.replyMessage(event.replyToken, { type: 'text', text: `🛡️✅ แต่งตั้ง Admin สำเร็จ:\n${admName}` });
        continue;
      }

      /* -> REMOVE Admin */
      if (lower.startsWith('remove admin')) {
        if (!isAdmin) {
          await client.replyMessage(event.replyToken, { type: 'text', text: '❌ Access Denied' });
          continue;
        }

        const [, , admId] = text.split(' ');

        // ป้องกันไม่ให้ลบ Super Admin (ตัวคุณเองใน .env)
        if (admId === process.env.ADMIN_USER_ID) {
           await client.replyMessage(event.replyToken, { type: 'text', text: '❌ ไม่สามารถลบ Super Admin ได้' });
           continue; 
        }

        const targetName = admins[admId]?.name || 'Unknown';
        if (!admins[admId]) {
            await client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ ไม่พบ Admin ท่านนี้' });
            continue;
        }

        admins[admId].active = false;
        await saveAdminToSheet({ userId: admId, name: targetName, status: 'inactive', promotedBy: userId });

        await client.replyMessage(event.replyToken, { type: 'text', text: `🛡️⛔ ถอดถอน Admin เรียบร้อย:\n${targetName}` });
        continue;
      }

      /* =========================================
         ZONE: Check-in
         ========================================= */
      if (lower === 'checkin') {
        // Admin เช็คอินได้ตลอดเวลา / Employee ต้อง Active
        if (!isAdmin && !employees[userId]?.active) {
          await client.replyMessage(event.replyToken, { type: 'text', text: '❌ คุณยังไม่ได้เป็นพนักงานในระบบ' });
          continue;
        }

        if (isSunday()) {
          await client.replyMessage(event.replyToken, { type: 'text', text: '❌ วันอาทิตย์ไม่ต้อง check-in ค่ะ' });
          continue;
        }

        if (isAfter0930() && !isAdmin) {
          await client.replyMessage(event.replyToken, { type: 'text', text: '⛔ ระบบปิด check-in แล้ว (หลัง 09:30)' });
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

      /* ===== work result ===== */
      if (lower.startsWith('work:')) {
        try {
            checkinStore[userId] = { date: today, workType: lower };
            await saveCheckinToSheet({ date: today, userId, name, workType: lower });
            await client.replyMessage(event.replyToken, { type: 'text', text: `✅ บันทึกเรียบร้อย\n${thaiDate}\n${name}` });
        } catch (err) {
            await client.replyMessage(event.replyToken, { type: 'text', text: `❌ Error: ${err.message}` });
        }
      }
    }
    res.sendStatus(200);
  } catch (e) {
    console.error('WEBHOOK ERROR:', e);
    res.sendStatus(500);
  }
});

/* ======================
   Start Server
====================== */
const PORT = process.env.PORT || 3000;
loadDataFromSheet().then(() => {
  app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
});
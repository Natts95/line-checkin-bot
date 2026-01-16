const express = require('express');
const line = require('@line/bot-sdk');
const cron = require('node-cron');
const { google } = require('googleapis');

/* ======================
   Config & Auth
====================== */
const auth = new google.auth.JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const app = express();
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new line.Client(config);

/* ======================
   Memory Store
====================== */
// เก็บ Check-in รายสัปดาห์ (Key = userId)
// Structure: { date: '2023-01-01', type: 'work:full' }
let checkinStore = {}; 

// เก็บธุรกรรมรายสัปดาห์ (Advance & Debt)
let weeklyTransactions = {
    advance: {}, // { userId: amount }
    repayment: {} // { userId: amount }
};

const employees = {}; // { userId: { name, active, dailyRate, totalDebt } }
const admins = {};

/* ======================
   Google Sheets Functions
====================== */
// 1. General Save Function (ใช้ร่วมกันได้)
async function saveToSheet(range, values) {
  try {
    await auth.authorize();
    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [values] },
    });
  } catch (err) { console.error(`❌ Save Error (${range}):`, err.message); }
}

// 2. Load Employees + Financial Data
async function loadDataFromSheet() {
  console.log('🔄 Loading data...');
  try {
    await auth.authorize();
    const sheets = google.sheets({ version: 'v4', auth });

    // Load Emp (Col A-F) -> Date, ID, Name, Status, AdminID, DailyRate, TotalDebt
    const empRes = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.SPREADSHEET_ID, range: 'employee!A:G' });
    if (empRes.data.values) {
        empRes.data.values.forEach(row => {
            const [, uid, name, status, , rate, debt] = row;
            if(!uid || uid === 'UserId') return;
            
            // Logic: เอาบรรทัดล่าสุดเสมอ
            if(status === 'active') {
                employees[uid] = { 
                    name, 
                    active: true,
                    dailyRate: parseInt(rate) || 0, // แปลงเป็นตัวเลข
                    totalDebt: parseInt(debt) || 0  // แปลงเป็นตัวเลข
                };
            } else if(status === 'inactive' && employees[uid]) {
                employees[uid].active = false;
            }
        });
    }

    // Load Admins
    const admRes = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.SPREADSHEET_ID, range: 'admin!A:E' });
    if (admRes.data.values) {
        admRes.data.values.forEach(row => {
            const [, uid, name, status] = row;
            if(!uid) return;
            if(status === 'active') admins[uid] = { name, active: true };
            else if(status === 'inactive' && admins[uid]) admins[uid].active = false;
        });
    }

    // Load Check-ins for THIS WEEK (เพื่อคำนวณเงิน)
    // หมายเหตุ: การดึงข้อมูลเพื่อนับวันทำงานย้อนหลังต้องใช้ Logic การกรองวันที่
    // เพื่อความง่ายใน Memory เราจะโหลดของ "วันนี้" มาก่อนเหมือนเดิม
    // ส่วนการคำนวณวันเสาร์ เราจะใช้ checkinStore ที่สะสมมาทั้งอาทิตย์ (อย่า Restart Server บ่อยช่วงระหว่างวีค)
    // หรือถ้า Restart ต้องมีฟังก์ชัน loadWeeklyCheckins (ซึ่งซับซ้อนกว่านี้) 
    // *เบื้องต้นใช้ logic สะสมใน memory ไปก่อน*
    
    console.log(`✅ Loaded: ${Object.keys(employees).length} Employees`);
  } catch(e) { console.error(e); }
}

/* ======================
   Helpers & Time Logic
====================== */
function getToday() { return new Date().toISOString().split('T')[0]; }
function isSunday() { return new Date().getDay() === 0; }
function isAfter0930() { 
  const d = new Date(); 
  return d.getHours() > 9 || (d.getHours() === 9 && d.getMinutes() >= 30); 
}
function formatThaiDate() {
    const d = new Date();
    const months = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
    return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()+543}`;
}

// ตรวจสอบช่วงเวลาทำธุรกรรม (พุธ/ศุกร์ 10:00 - 13:00)
function isTransactionTime() {
    const d = new Date();
    const hour = d.getHours();
    // 10:00 - 12:59
    return hour >= 10 && hour < 13;
}

/* ======================
   ⏰ CRON JOBS
====================== */

// 1. จันทร์-เสาร์ 09:20 -> เตือน Check-in
cron.schedule('20 9 * * 1-6', async () => { 
  const today = getToday();
  for (const uid in employees) {
    if (employees[uid].active) {
      // เช็คว่าวันนี้มี record ใน checkinStore หรือยัง (ต้องปรับโครงสร้าง checkinStore เล็กน้อย)
      const hasCheckedIn = checkinStore[uid]?.find(r => r.date === today);
      if (!hasCheckedIn) {
        try { await client.pushMessage(uid, { type: 'text', text: `⚠️ อีก 10 นาทีปิด Check-in ครับ` }); } 
        catch (e) {}
      }
    }
  }
}, { timezone: "Asia/Bangkok" });

// 2. จันทร์-เสาร์ 09:45 -> รายงาน Admin (Check-in ประจำวัน)
cron.schedule('45 9 * * 1-6', async () => {
    // ... (Code เดิม - รายงานใครมาไม่มา) ...
    // ขออนุญาตละไว้เพื่อความกระชับ (ใช้ code เดิมได้เลย)
}, { timezone: "Asia/Bangkok" });


/* ============ 💰 FINANCE CRON JOBS ============ */

// 3. พุธ 10:00 -> เปิดให้เบิกเงิน
cron.schedule('0 10 * * 3', async () => { // 3 = Wednesday
    for (const uid in employees) {
        if (!employees[uid].active) continue;
        await client.pushMessage(uid, {
            type: 'template',
            altText: 'ต้องการเบิกเงินวันนี้ไหมครับ?',
            template: {
                type: 'confirm',
                text: `💸 วันพุธแล้ว ต้องการ "เบิกเงินล่วงหน้า" ไหมครับ?\n(หมดเขต 13:00 น.)`,
                actions: [
                    { label: 'ต้องการ', type: 'postback', data: 'req_advance:yes' },
                    { label: 'ไม่ต้องการ', type: 'message', text: 'ไม่เบิกครับ' }
                ]
            }
        }).catch(()=>{});
    }
}, { timezone: "Asia/Bangkok" });

// 4. พุธ 13:30 -> สรุปยอดเบิกให้ Admin
cron.schedule('30 13 * * 3', async () => {
    let msg = `💸 สรุปยอดเบิกวันพุธ\n----------------\n`;
    let total = 0;
    for(const uid in weeklyTransactions.advance) {
        const amount = weeklyTransactions.advance[uid];
        const name = employees[uid]?.name || 'Unknown';
        msg += `${name}: ${amount} บ.\n`;
        total += amount;
    }
    msg += `----------------\nรวมทั้งสิ้น: ${total} บาท`;
    await client.pushMessage(process.env.ADMIN_USER_ID, { type: 'text', text: msg });
}, { timezone: "Asia/Bangkok" });

// 5. ศุกร์ 10:00 -> เปิดให้จ่ายหนี้
cron.schedule('0 10 * * 5', async () => { // 5 = Friday
    for (const uid in employees) {
        if (!employees[uid].active) continue;
        const currentDebt = employees[uid].totalDebt || 0;
        if (currentDebt <= 0) continue; // ไม่มีหนี้ไม่ต้องถาม

        await client.pushMessage(uid, {
            type: 'template',
            altText: 'ต้องการหักหนี้วันนี้ไหมครับ?',
            template: {
                type: 'confirm',
                text: `📉 วันศุกร์แล้ว หักหนี้ไหมครับ?\n(หนี้คงเหลือ: ${currentDebt} บ.)`,
                actions: [
                    { label: 'หักหนี้', type: 'postback', data: 'req_repayment:yes' },
                    { label: 'ไม่หัก', type: 'message', text: 'ไม่หักหนี้ครับ' }
                ]
            }
        }).catch(()=>{});
    }
}, { timezone: "Asia/Bangkok" });

// 6. ศุกร์ 13:30 -> สรุปยอดหักหนี้ให้ Admin
cron.schedule('30 13 * * 5', async () => {
    let msg = `📉 สรุปยอดหักหนี้วันศุกร์\n----------------\n`;
    let total = 0;
    for(const uid in weeklyTransactions.repayment) {
        const amount = weeklyTransactions.repayment[uid];
        const name = employees[uid]?.name || 'Unknown';
        msg += `${name}: ${amount} บ.\n`;
        total += amount;
    }
    msg += `----------------\nรวมทั้งสิ้น: ${total} บาท`;
    await client.pushMessage(process.env.ADMIN_USER_ID, { type: 'text', text: msg });
}, { timezone: "Asia/Bangkok" });

// 7. เสาร์ 10:00 -> 📊 WEEKLY REPORT (Payroll)
cron.schedule('0 10 * * 6', async () => { // 6 = Saturday
    let adminReport = `💰 รายงานสรุปค่าแรงประจำสัปดาห์\n${formatThaiDate()}\n=====================\n`;
    
    for (const uid in employees) {
        if (!employees[uid].active) continue;

        const emp = employees[uid];
        // คำนวณวันทำงาน
        const userCheckins = checkinStore[uid] || [];
        let fullDays = 0;
        let halfDays = 0;
        let workDaysCount = 0;

        userCheckins.forEach(c => {
            if(c.workType.includes('full')) { fullDays++; workDaysCount++; }
            else if(c.workType.includes('half')) { halfDays++; workDaysCount += 0.5; }
        });

        // คำนวณเงิน
        const grossPay = workDaysCount * emp.dailyRate;
        const advance = weeklyTransactions.advance[uid] || 0;
        const debtPaid = weeklyTransactions.repayment[uid] || 0;
        const netPay = grossPay - advance - debtPaid;
        const remainingDebt = Math.max(0, emp.totalDebt - debtPaid); // หนี้ที่เหลือในระบบ (Display Only)

        // 1. สร้างสลิปส่งให้พนักงาน
        const slip = `🧾 สลิปเงินเดือน (Weekly)\nคุณ: ${emp.name}\n` +
                     `-----------------------\n` +
                     `ทำงาน: ${fullDays} วันเต็ม, ${halfDays} ครึ่งวัน\n` +
                     `ค่าแรงรวม: ${grossPay.toLocaleString()} บ.\n` +
                     `หักเบิกวันพุธ: -${advance.toLocaleString()} บ.\n` +
                     `หักชำระหนี้: -${debtPaid.toLocaleString()} บ.\n` +
                     `-----------------------\n` +
                     `💰 เงินสุทธิ: ${netPay.toLocaleString()} บาท\n` +
                     `(หนี้คงเหลือโดยประมาณ: ${remainingDebt.toLocaleString()} บ.)`;
        
        await client.pushMessage(uid, { type: 'text', text: slip }).catch(()=>{});

        // 2. เติมข้อมูลลงรายงาน Admin
        adminReport += `👤 ${emp.name}\n` +
                       `   - งาน: ${workDaysCount} วัน (${grossPay})\n` +
                       `   - หัก: เบิก ${advance} / หนี้ ${debtPaid}\n` +
                       `   - จ่ายสุทธิ: ${netPay.toLocaleString()} บ.\n`;
    }

    // ส่งหา Admin
    await client.pushMessage(process.env.ADMIN_USER_ID, { type: 'text', text: adminReport }).catch(()=>{});

    // Reset Weekly Data
    // checkinStore = {}; // (Optional: ถ้าต้องการเคลียร์ทุกวีค)
    weeklyTransactions = { advance: {}, repayment: {} };

}, { timezone: "Asia/Bangkok" });


/* ======================
   Webhook
====================== */
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    for (const event of req.body.events) {
      const userId = event.source.userId;
      const isAdmin = userId === process.env.ADMIN_USER_ID || admins[userId]?.active;
      
      // Handle Postback (กดปุ่ม Confirm)
      if (event.type === 'postback') {
          const data = event.postback.data;
          
          // ขอเบิกเงิน (Step 1)
          if (data === 'req_advance:yes') {
             if (!isTransactionTime()) {
                 await client.replyMessage(event.replyToken, { type: 'text', text: '❌ หมดเวลาเบิกเงินแล้วครับ (10:00-13:00)' });
                 continue;
             }
             await client.replyMessage(event.replyToken, { type: 'text', text: 'กรุณาพิมพ์ยอดเงินที่ต้องการเบิก\nเช่น "berk:500"' });
          }

          // ขอจ่ายหนี้ (Step 1)
          if (data === 'req_repayment:yes') {
             if (!isTransactionTime()) {
                 await client.replyMessage(event.replyToken, { type: 'text', text: '❌ หมดเวลาทำรายการแล้วครับ (10:00-13:00)' });
                 continue;
             }
             await client.replyMessage(event.replyToken, { type: 'text', text: 'กรุณาพิมพ์ยอดหนี้ที่ต้องการหัก\nเช่น "paydebt:500"' });
          }
          continue;
      }

      if (event.type !== 'message' || event.message.type !== 'text') continue;
      const text = event.message.text.trim();
      const lower = text.toLowerCase();
      const today = getToday();

      // ... (Code ส่วน add/remove employee/admin เดิม ใส่ตรงนี้) ...
      // เพื่อความกระชับ ขอข้ามส่วน Admin Management เดิมไป (แต่ต้องมีนะ)

      /* ===== 1. Check-in Logic ===== */
      if (lower.startsWith('work:')) {
         // เก็บเป็น Array เพื่อรองรับหลายวันใน 1 วีค
         if (!checkinStore[userId]) checkinStore[userId] = [];
         
         // เช็คซ้ำวันเดิม
         const already = checkinStore[userId].find(r => r.date === today);
         if (already) {
             await client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ วันนี้ลงเวลาไปแล้วครับ' });
             continue;
         }

         checkinStore[userId].push({ date: today, workType: lower });
         
         // Save to Sheet
         const profile = await client.getProfile(userId);
         await saveToSheet('checkin!A:E', [today, userId, profile.displayName, lower, new Date().toLocaleString('th-TH')]);
         
         await client.replyMessage(event.replyToken, { type: 'text', text: '✅ บันทึกเวลาเรียบร้อย' });
         continue;
      }
      
      /* ===== 2. เบิกเงิน (Wednesday) ===== */
      if (lower.startsWith('berk:')) {
          if (new Date().getDay() !== 3) { // 3=Wednesday
              await client.replyMessage(event.replyToken, { type: 'text', text: '❌ ระบบเบิกเปิดเฉพาะวันพุธครับ' });
              continue;
          }
          if (!isTransactionTime()) {
              await client.replyMessage(event.replyToken, { type: 'text', text: '❌ ไม่อยู่ในช่วงเวลาเบิก (10:00-13:00)' });
              continue;
          }

          const amount = parseInt(text.split(':')[1]);
          if (!amount || isNaN(amount)) {
              await client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ ใส่ตัวเลขด้วยครับ เช่น berk:500' });
              continue;
          }

          weeklyTransactions.advance[userId] = amount;
          const profile = await client.getProfile(userId);
          await saveToSheet('advance!A:E', [today, userId, profile.displayName, amount, new Date().toLocaleString('th-TH')]);

          await client.replyMessage(event.replyToken, { type: 'text', text: `✅ บันทึกยอดเบิก ${amount} บาท เรียบร้อย` });
          continue;
      }

      /* ===== 3. จ่ายหนี้ (Friday) ===== */
      if (lower.startsWith('paydebt:')) {
          if (new Date().getDay() !== 5) { // 5=Friday
              await client.replyMessage(event.replyToken, { type: 'text', text: '❌ ระบบตัดหนี้เปิดเฉพาะวันศุกร์ครับ' });
              continue;
          }
          if (!isTransactionTime()) {
              await client.replyMessage(event.replyToken, { type: 'text', text: '❌ ไม่อยู่ในช่วงเวลา (10:00-13:00)' });
              continue;
          }

          const amount = parseInt(text.split(':')[1]);
          if (!amount || isNaN(amount)) {
              await client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ ใส่ตัวเลขด้วยครับ เช่น paydebt:500' });
              continue;
          }

          // Optional: เช็คว่าจ่ายเกินหนี้ที่มีไหม
          const currentDebt = employees[userId]?.totalDebt || 0;
          if (amount > currentDebt) {
             await client.replyMessage(event.replyToken, { type: 'text', text: `⚠️ ยอดเกินหนี้ที่มี (${currentDebt} บ.) ครับ` });
             continue;
          }

          weeklyTransactions.repayment[userId] = amount;
          const profile = await client.getProfile(userId);
          await saveToSheet('repayment!A:E', [today, userId, profile.displayName, amount, new Date().toLocaleString('th-TH')]);

          await client.replyMessage(event.replyToken, { type: 'text', text: `✅ บันทึกหักหนี้ ${amount} บาท เรียบร้อย` });
          continue;
      }
      
      // ปุ่ม Checkin
      if (lower === 'checkin') {
         // ... (Logic ปุ่ม Checkin เหมือนเดิม) ...
         const thaiDate = formatThaiDate();
         const profile = await client.getProfile(userId);
         await client.replyMessage(event.replyToken, {
          type: 'template',
          altText: 'Check-in',
          template: {
            type: 'buttons',
            text: `${thaiDate}\n${profile.displayName} ทำงานแบบไหนครับ?`,
            actions: [
              { label: 'เต็มวัน', type: 'message', text: 'work:full' },
              { label: 'ครึ่งเช้า', type: 'message', text: 'work:half-morning' },
              { label: 'ครึ่งบ่าย', type: 'message', text: 'work:half-afternoon' },
              { label: 'หยุด', type: 'message', text: 'work:off' },
            ],
          },
        });
      }

    } // end for loop

    res.sendStatus(200);
  } catch (e) {
    console.error(e);
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
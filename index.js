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
let checkinStore = {}; 
let weeklyTransactions = {
    advance: {}, 
    repayment: {} 
};
const employees = {}; 
const admins = {};

/* ======================
   Google Sheets Functions
====================== */
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

async function updateDebtInSheet(targetUserId, newDebtAmount) {
  try {
    await auth.authorize();
    const sheets = google.sheets({ version: 'v4', auth });
    const readRes = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: 'employee!B:B', 
    });

    const rows = readRes.data.values;
    if (!rows || rows.length === 0) return;

    let targetRow = -1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][0] === targetUserId) {
        targetRow = i + 1;
        break;
      }
    }

    if (targetRow === -1) return;

    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: `employee!G${targetRow}`, 
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[newDebtAmount]] },
    });
    console.log(`✅ Update Debt: Row ${targetRow}, Amount ${newDebtAmount}`);
  } catch (err) { console.error('❌ UPDATE DEBT ERROR:', err.message); }
}

async function loadDataFromSheet() {
  console.log('🔄 Loading data...');
  try {
    await auth.authorize();
    const sheets = google.sheets({ version: 'v4', auth });

    // Load Employees
    const empRes = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.SPREADSHEET_ID, range: 'employee!A:G' });
    if (empRes.data.values) {
        empRes.data.values.forEach(row => {
            const [, uid, name, status, , rate, debt] = row;
            if(!uid || uid === 'UserId') return;
            if(status === 'active') {
                employees[uid] = { name, active: true, dailyRate: parseInt(rate)||0, totalDebt: parseInt(debt)||0 };
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

    // Load Checkins Today
    const today = getToday();
    const checkinRes = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.SPREADSHEET_ID, range: 'checkin!A:E' });
    if (checkinRes.data.values) {
        checkinRes.data.values.forEach(row => {
            if(row[0] === today) {
                if(!checkinStore[row[1]]) checkinStore[row[1]] = [];
                const exists = checkinStore[row[1]].find(r => r.date === today);
                if(!exists) checkinStore[row[1]].push({ date: row[0], workType: row[3] });
            }
        });
    }
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
function isTransactionTime() {
    const d = new Date();
    const hour = d.getHours();
    return hour >= 10 && hour < 13; // 10:00 - 12:59
}

/* ======================
   ⏰ CRON JOBS
====================== */

// 1. 09:20 -> เตือน Check-in (จันทร์-เสาร์)
cron.schedule('20 9 * * 1-6', async () => { 
  const today = getToday();
  for (const uid in employees) {
    if (employees[uid].active) {
      const hasCheckedIn = checkinStore[uid]?.find(r => r.date === today);
      if (!hasCheckedIn) {
        try { 
            await client.pushMessage(uid, { 
                type: 'text', 
                text: `⚠️ เรียนคุณ ${employees[uid].name}\nอีก 10 นาทีระบบจะปิด Check-in แล้วนะคะ` 
            }); 
        } catch (e) {}
      }
    }
  }
}, { timezone: "Asia/Bangkok" });

// 2. 09:45 -> รายงาน Admin
cron.schedule('45 9 * * 1-6', async () => {
    const today = getToday();
    let report = `📊 สรุปการลงเวลา\n${formatThaiDate()}\n------------------\n`;
    let notCheckedIn = [];
    let checkedIn = [];

    for (const uid in employees) {
        if (employees[uid].active) {
            const record = checkinStore[uid]?.find(r => r.date === today);
            if (record) {
                let type = '✅ มาทำงาน';
                if (record.workType.includes('half')) type = '⛅ ครึ่งวัน';
                else if (record.workType.includes('off')) type = '🏠 หยุด';
                checkedIn.push(`${employees[uid].name} : ${type}`);
            } else {
                notCheckedIn.push(`❌ ${employees[uid].name}`);
            }
        }
    }
    if (checkedIn.length > 0) report += checkedIn.join('\n') + '\n';
    if (notCheckedIn.length > 0) report += `\n[ยังไม่เช็คอิน]\n` + notCheckedIn.join('\n');
    else report += `\n(ครบทุกคน)`;

    await client.pushMessage(process.env.ADMIN_USER_ID, { type: 'text', text: report }).catch(()=>{});
}, { timezone: "Asia/Bangkok" });

// 3. พุธ 10:00 -> เปิดให้เบิกเงิน
cron.schedule('0 10 * * 3', async () => { 
    for (const uid in employees) {
        if (!employees[uid].active) continue;
        await client.pushMessage(uid, {
            type: 'template',
            altText: 'ต้องการเบิกเงินวันนี้ไหมคะ?',
            template: {
                type: 'confirm',
                text: `💸 เรียนคุณ ${employees[uid].name}\nวันพุธแล้ว ต้องการ "เบิกเงินล่วงหน้า" ไหมคะ?\n(หมดเวลา 13:00 น.)`,
                actions: [
                    { label: 'ต้องการ', type: 'postback', data: 'req_advance:yes' },
                    { label: 'ไม่ต้องการ', type: 'message', text: 'ไม่เบิกค่ะ' }
                ]
            }
        }).catch(()=>{});
    }
}, { timezone: "Asia/Bangkok" });

// 4. พุธ 13:30 -> สรุปยอดเบิก
cron.schedule('30 13 * * 3', async () => {
    let msg = `💸 สรุปยอดเบิกวันพุธ\n----------------\n`;
    let total = 0;
    for(const uid in weeklyTransactions.advance) {
        msg += `${employees[uid]?.name || uid}: ${weeklyTransactions.advance[uid]} บาท\n`;
        total += weeklyTransactions.advance[uid];
    }
    msg += `----------------\nรวม: ${total} บาท`;
    await client.pushMessage(process.env.ADMIN_USER_ID, { type: 'text', text: msg });
}, { timezone: "Asia/Bangkok" });

// 5. ศุกร์ 10:00 -> เปิดให้จ่ายหนี้
cron.schedule('0 10 * * 5', async () => { 
    for (const uid in employees) {
        if (!employees[uid].active) continue;
        const currentDebt = employees[uid].totalDebt || 0;
        if (currentDebt <= 0) continue;

        await client.pushMessage(uid, {
            type: 'template',
            altText: 'ต้องการหักหนี้วันนี้ไหมคะ?',
            template: {
                type: 'confirm',
                text: `📉 เรียนคุณ ${employees[uid].name}\nวันศุกร์แล้ว หักหนี้ไหมคะ?\n(หนี้คงเหลือ: ${currentDebt} บาท)`,
                actions: [
                    { label: 'หักหนี้', type: 'postback', data: 'req_repayment:yes' },
                    { label: 'ไม่หัก', type: 'message', text: 'ไม่หักหนี้ค่ะ' }
                ]
            }
        }).catch(()=>{});
    }
}, { timezone: "Asia/Bangkok" });

// 6. ศุกร์ 13:30 -> สรุปยอดหักหนี้
cron.schedule('30 13 * * 5', async () => {
    let msg = `📉 สรุปยอดหักหนี้วันศุกร์\n----------------\n`;
    let total = 0;
    for(const uid in weeklyTransactions.repayment) {
        msg += `${employees[uid]?.name || uid}: ${weeklyTransactions.repayment[uid]} บาท\n`;
        total += weeklyTransactions.repayment[uid];
    }
    msg += `----------------\nรวม: ${total} บาท`;
    await client.pushMessage(process.env.ADMIN_USER_ID, { type: 'text', text: msg });
}, { timezone: "Asia/Bangkok" });

// 7. เสาร์ 10:00 -> Payroll Report
cron.schedule('0 10 * * 6', async () => { 
    let adminReport = `💰 สรุปค่าแรงประจำสัปดาห์\n${formatThaiDate()}\n=====================\n`;
    
    for (const uid in employees) {
        if (!employees[uid].active) continue;
        const emp = employees[uid];
        const userCheckins = checkinStore[uid] || [];
        let fullDays = 0, halfDays = 0, workDaysCount = 0;

        userCheckins.forEach(c => {
            if(c.workType.includes('full')) { fullDays++; workDaysCount++; }
            else if(c.workType.includes('half')) { halfDays++; workDaysCount += 0.5; }
        });

        const grossPay = workDaysCount * emp.dailyRate;
        const advance = weeklyTransactions.advance[uid] || 0;
        const debtPaid = weeklyTransactions.repayment[uid] || 0;
        const netPay = grossPay - advance - debtPaid;
        const remainingDebt = emp.totalDebt;

        // สลิปพนักงาน
        const slip = `🧾 สลิปเงินเดือน (Weekly)\n👤 ชื่อ: ${emp.name}\n📅 ประจำวันที่: ${formatThaiDate()}\n` +
                     `-----------------------\n` +
                     `✅ ทำงาน: ${fullDays} วันเต็ม, ${halfDays} ครึ่งวัน\n` +
                     `💵 ค่าแรงรวม: ${grossPay.toLocaleString()} บาท\n` +
                     `💸 หักเบิกวันพุธ: -${advance.toLocaleString()} บาท\n` +
                     `📉 หักชำระหนี้: -${debtPaid.toLocaleString()} บาท\n` +
                     `-----------------------\n` +
                     `💰 เงินรับสุทธิ: ${netPay.toLocaleString()} บาท\n` +
                     `(หนี้คงเหลือ: ${remainingDebt.toLocaleString()} บาท)`;
        
        await client.pushMessage(uid, { type: 'text', text: slip }).catch(()=>{});

        // รายงาน Admin
        adminReport += `👤 ${emp.name}\n   งาน: ${workDaysCount}วัน, จ่ายสุทธิ: ${netPay} บาท\n`;
    }

    await client.pushMessage(process.env.ADMIN_USER_ID, { type: 'text', text: adminReport }).catch(()=>{});
    
    weeklyTransactions = { advance: {}, repayment: {} };
}, { timezone: "Asia/Bangkok" });


/* ======================
   Webhook
====================== */
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    for (const event of req.body.events) {
      const userId = event.source.userId;
      const isSuperAdmin = userId === process.env.ADMIN_USER_ID;
      const isAdmin = isSuperAdmin || admins[userId]?.active;
      
      const profile = await client.getProfile(userId);
      const name = employees[userId]?.name || profile.displayName; // ใช้ชื่อในระบบก่อน ถ้าไม่มีใช้ชื่อไลน์
      const thaiDate = formatThaiDate();

      // Handle Postback
      if (event.type === 'postback') {
          const data = event.postback.data;
          
          if (data === 'req_advance:yes') {
             if (!isTransactionTime()) {
                 await client.replyMessage(event.replyToken, { type: 'text', text: `❌ คุณ ${name} คะ\nหมดเวลาทำรายการแล้วค่ะ (10:00-13:00)` });
                 continue;
             }
             await client.replyMessage(event.replyToken, { type: 'text', text: `กรุณาพิมพ์คำว่า "เบิก" ตามด้วยตัวเลข\nเช่น เบิก 500` });
          }

          if (data === 'req_repayment:yes') {
             if (!isTransactionTime()) {
                 await client.replyMessage(event.replyToken, { type: 'text', text: `❌ คุณ ${name} คะ\nหมดเวลาทำรายการแล้วค่ะ (10:00-13:00)` });
                 continue;
             }
             await client.replyMessage(event.replyToken, { type: 'text', text: `กรุณาพิมพ์คำว่า "หัก" หรือ "คืน" ตามด้วยตัวเลข\nเช่น หัก 500` });
          }
          continue;
      }

      if (event.type !== 'message' || event.message.type !== 'text') continue;
      const text = event.message.text.trim();
      const lower = text.toLowerCase();
      const today = getToday();

      /* ===== 0. Utility Commands ===== */
      
      if (lower === 'whoami') {
        let role = 'Guest';
        if (isSuperAdmin) role = '👑 Super Admin';
        else if (isAdmin) role = '🛡️ Admin';
        else if (employees[userId]?.active) role = '💼 Employee';
        
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: `👤 ชื่อ: ${name}\nID: ${userId}\nสถานะ: ${role}`
        });
        continue;
      }

      if (lower === 'update data') {
          if (!isAdmin) {
              await client.replyMessage(event.replyToken, { type: 'text', text: '❌ Access Denied' });
              continue;
          }
          await client.replyMessage(event.replyToken, { type: 'text', text: '🔄 กำลังดึงข้อมูลล่าสุดจาก Google Sheet...' });
          await loadDataFromSheet();
          await client.pushMessage(userId, { type: 'text', text: '✅ อัปเดตข้อมูลพนักงาน/การเงิน เรียบร้อยแล้วค่ะ!' });
          continue;
      }

      // Admin Management
      if (lower.startsWith('add employee')) {
          if(!isAdmin) { await client.replyMessage(event.replyToken, {type:'text', text:'❌ Admin Only'}); continue; }
          const [,,eid, ...n] = text.split(' ');
          const ename = n.join(' ')||'Emp';
          if(!eid) continue;
          
          employees[eid] = { name: ename, active: true, dailyRate: 0, totalDebt: 0 };
          await saveToSheet('employee!A:G', [new Date().toLocaleString('th-TH'), eid, ename, 'active', userId, 0, 0]);
          await client.replyMessage(event.replyToken, {type:'text', text:`✅ เพิ่มพนักงาน: ${ename} เรียบร้อยค่ะ\n(อย่าลืมไปใส่ค่าแรง/หนี้ใน Sheet และกด update data นะคะ)`});
          continue;
      }
      
      if (lower.startsWith('remove employee')) {
          if(!isAdmin) { await client.replyMessage(event.replyToken, {type:'text', text:'❌ Admin Only'}); continue; }
          const [,,eid] = text.split(' ');
          if(employees[eid]) {
             employees[eid].active = false;
             await saveToSheet('employee!A:G', [new Date().toLocaleString('th-TH'), eid, employees[eid].name, 'inactive', userId]);
             await client.replyMessage(event.replyToken, {type:'text', text:`⛔ ลบพนักงาน: ${employees[eid].name} เรียบร้อยค่ะ`});
          }
          continue;
      }

      if (lower.startsWith('add admin')) {
          if(!isAdmin) { await client.replyMessage(event.replyToken, {type:'text', text:'❌ Admin Only'}); continue; }
          const [,,aid, ...n] = text.split(' ');
          const aname = n.join(' ')||'Admin';
          if(!aid) continue;
          
          admins[aid] = { name: aname, active: true };
          await saveToSheet('admin!A:E', [new Date().toLocaleString('th-TH'), aid, aname, 'active', userId]);
          await client.replyMessage(event.replyToken, {type:'text', text:`🛡️ แต่งตั้ง Admin: ${aname} เรียบร้อยค่ะ`});
          continue;
      }


      /* ===== 1. Check-in Logic ===== */
      if (lower.startsWith('work:')) {
         if (!checkinStore[userId]) checkinStore[userId] = [];
         
         const already = checkinStore[userId].find(r => r.date === today);
         if (already) {
             await client.replyMessage(event.replyToken, { type: 'text', text: `⚠️ คุณ ${name} คะ วันนี้ลงเวลาไปแล้วค่ะ` });
             continue;
         }

         // แปลงสถานะเป็นภาษาไทย
         let statusTh = 'ทำงานเต็มวัน';
         if(lower.includes('half-morning')) statusTh = 'ครึ่งเช้า';
         else if(lower.includes('half-afternoon')) statusTh = 'ครึ่งบ่าย';
         else if(lower.includes('off')) statusTh = 'หยุดงาน';

         checkinStore[userId].push({ date: today, workType: lower });
         await saveToSheet('checkin!A:E', [today, userId, name, lower, new Date().toLocaleString('th-TH')]);
         
         await client.replyMessage(event.replyToken, { 
             type: 'text', 
             text: `✅ บันทึกเวลาเรียบร้อยค่ะ\n👤 ชื่อ: ${name}\n📅 วันที่: ${thaiDate}\n📝 สถานะ: ${statusTh}` 
         });
         continue;
      }
      
      /* ===== 2. เบิกเงิน (ง่ายขึ้น: พิมพ์ "เบิก 500") ===== */
      if (lower.startsWith('berk:') || lower.startsWith('เบิก')) {
          if (new Date().getDay() !== 3) { 
              await client.replyMessage(event.replyToken, { type: 'text', text: '❌ ระบบเบิกเปิดเฉพาะวันพุธค่ะ' });
              continue;
          }
          if (!isTransactionTime()) {
              await client.replyMessage(event.replyToken, { type: 'text', text: '❌ ไม่อยู่ในช่วงเวลาเบิกค่ะ (10:00-13:00)' });
              continue;
          }

          // รองรับทั้ง "berk:500", "เบิก 500", "เบิก500"
          let amountStr = text.replace('berk:', '').replace('เบิก', '').trim();
          const amount = parseInt(amountStr);

          if (!amount || isNaN(amount)) {
              await client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ กรุณาใส่ตัวเลขด้วยค่ะ เช่น "เบิก 500"' });
              continue;
          }

          weeklyTransactions.advance[userId] = amount;
          await saveToSheet('advance!A:E', [today, userId, name, amount, new Date().toLocaleString('th-TH')]);
          await client.replyMessage(event.replyToken, { 
              type: 'text', 
              text: `✅ ทำรายการเบิกสำเร็จค่ะ\n👤 ชื่อ: ${name}\n💸 ยอดเบิก: ${amount} บาท\n📅 วันที่: ${thaiDate}` 
          });
          continue;
      }

      /* ===== 3. จ่ายหนี้ (ง่ายขึ้น: พิมพ์ "หัก 500" หรือ "คืน 500") ===== */
      if (lower.startsWith('paydebt:') || lower.startsWith('หัก') || lower.startsWith('คืน')) {
          if (new Date().getDay() !== 5) { 
              await client.replyMessage(event.replyToken, { type: 'text', text: '❌ ระบบหักหนี้เปิดเฉพาะวันศุกร์ค่ะ' });
              continue;
          }
          if (!isTransactionTime()) {
              await client.replyMessage(event.replyToken, { type: 'text', text: '❌ ไม่อยู่ในช่วงเวลาค่ะ (10:00-13:00)' });
              continue;
          }

          let amountStr = text.replace('paydebt:', '').replace('หัก', '').replace('คืน', '').trim();
          const amount = parseInt(amountStr);

          if (!amount || isNaN(amount)) {
              await client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ กรุณาใส่ตัวเลขด้วยค่ะ เช่น "หัก 500"' });
              continue;
          }

          const currentDebt = employees[userId]?.totalDebt || 0;
          if (amount > currentDebt) {
             await client.replyMessage(event.replyToken, { type: 'text', text: `⚠️ ยอดเกินหนี้ที่มี (${currentDebt} บาท) ค่ะ` });
             continue;
          }

          // Logic
          const newDebt = currentDebt - amount;
          if(employees[userId]) employees[userId].totalDebt = newDebt;

          weeklyTransactions.repayment[userId] = amount;
          await saveToSheet('repayment!A:E', [today, userId, name, amount, new Date().toLocaleString('th-TH')]);
          await updateDebtInSheet(userId, newDebt);

          await client.replyMessage(event.replyToken, { 
              type: 'text', 
              text: `✅ ทำรายการหักหนี้สำเร็จค่ะ\n👤 ชื่อ: ${name}\n📉 ยอดหัก: ${amount} บาท\n📉 หนี้คงเหลือ: ${newDebt} บาท\n📅 วันที่: ${thaiDate}` 
          });
          continue;
      }
      
      // ปุ่ม Checkin
      if (lower === 'checkin') {
         if (!isAdmin && !employees[userId]?.active) {
            await client.replyMessage(event.replyToken, { type: 'text', text: '❌ คุณยังไม่ได้เป็นพนักงานในระบบ\nกรุณาติดต่อ Admin ค่ะ' });
            continue;
         }

         if (checkinStore[userId]?.find(r => r.date === today)) {
             await client.replyMessage(event.replyToken, { type: 'text', text: `⚠️ คุณ ${name} คะ วันนี้ลงเวลาไปแล้วค่ะ` });
             continue;
         }

         if (isSunday()) { await client.replyMessage(event.replyToken, {type:'text', text:'❌ วันอาทิตย์หยุดนะคะ'}); continue; }
         if (isAfter0930() && !isAdmin) { await client.replyMessage(event.replyToken, {type:'text', text:'⛔ สายแล้วค่ะ (ระบบปิด 09:30)'}); continue; }

         await client.replyMessage(event.replyToken, {
          type: 'template',
          altText: 'Check-in',
          template: {
            type: 'buttons',
            text: `${thaiDate}\nคุณ ${name} วันนี้ทำงานแบบไหนคะ?`,
            actions: [
              { label: 'เต็มวัน', type: 'message', text: 'work:full' },
              { label: 'ครึ่งเช้า', type: 'message', text: 'work:half-morning' },
              { label: 'ครึ่งบ่าย', type: 'message', text: 'work:half-afternoon' },
              { label: 'หยุด', type: 'message', text: 'work:off' },
            ],
          },
        });
      }

    } 
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
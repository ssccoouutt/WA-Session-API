import express from 'express';
import fs from 'fs';
import pino from 'pino';
import { makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore, Browsers, jidNormalizedUser, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pn from 'awesome-phonenumber';
import zlib from 'zlib';

const router = express.Router();

// Ensure the session directory exists
function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        fs.rmSync(FilePath, { recursive: true, force: true });
    } catch (e) {
        console.error('Error removing file:', e);
    }
}

// Generate gzip compressed base64 session string
function generateSessionString(credsPath) {
    try {
        const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
        const jsonString = JSON.stringify(creds, null, 0);
        const compressedData = zlib.gzipSync(jsonString);
        const base64Data = compressedData.toString('base64');
        const sessionString = `KnightBot!${base64Data}`;
        
        const txtPath = credsPath.replace('creds.json', 'session.txt');
        fs.writeFileSync(txtPath, sessionString);
        console.log(`✅ Session string saved to: ${txtPath}`);
        
        return sessionString;
    } catch (error) {
        console.error('Error generating session string:', error);
        return null;
    }
}

router.get('/', async (req, res) => {
    let num = req.query.number;
    let dirs = './' + (num || `session`);
    let isCompleted = false; // Flag to prevent multiple cleanup attempts

    // Remove existing session if present
    await removeFile(dirs);

    // Clean the phone number - remove any non-digit characters
    num = num.replace(/[^0-9]/g, '');

    // Validate the phone number
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
        
        // Track if we've already sent the response
        let responseSent = false;

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
                // IMPORTANT: Don't automatically reconnect
                shouldReconnect: () => false,
            });

            KnightBot.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, isNewLogin, isOnline } = update;

                if (connection === 'open') {
                    console.log("✅ Connected successfully!");
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
                        console.log("📄 Session file sent successfully");

                        // Generate and send session string
                        const sessionString = generateSessionString(dirs + '/creds.json');
                        if (sessionString) {
                            await KnightBot.sendMessage(userJid, {
                                text: `🔐 *Your Session String:*\n\n\`\`\`${sessionString}\`\`\`\n\n_Keep this safe! Do not share with anyone._`
                            });
                            console.log("🔐 Session string sent successfully");
                        }

                        // Send video thumbnail
                        await KnightBot.sendMessage(userJid, {
                            image: { url: 'https://img.youtube.com/vi/-oz_u1iMgf8/maxresdefault.jpg' },
                            caption: `🎬 *KnightBot MD V2.0 Full Setup Guide!*\n\n🚀 Bug Fixes + New Commands + Fast AI Chat\n📺 Watch Now: https://youtu.be/NjOipI2AoMk`
                        });
                        console.log("🎬 Video guide sent successfully");

                        // Send warning message
                        await KnightBot.sendMessage(userJid, {
                            text: `⚠️Do not share this file with anybody⚠️\n 
┌┤✑  Thanks for using Knight Bot
│└────────────┈ ⳹        
│©2025 Mr Unique Hacker 
└─────────────────┈ ⳹\n\n`
                        });
                        console.log("⚠️ Warning message sent successfully");

                        console.log("✅ All messages sent successfully!");
                        
                        // IMPORTANT: Clean up and disconnect
                        console.log("🧹 Cleaning up session...");
                        
                        // Close the connection properly
                        await KnightBot.end(new Error("Session generation completed"));
                        
                        // Delete session files after a short delay
                        await delay(2000);
                        if (!isCompleted) {
                            isCompleted = true;
                            removeFile(dirs);
                            console.log("✅ Session files cleaned up successfully");
                            console.log("🎉 Process completed successfully!");
                        }
                        
                    } catch (error) {
                        console.error("❌ Error sending messages:", error);
                        // Clean up even if there's an error
                        if (!isCompleted) {
                            isCompleted = true;
                            await KnightBot.end(new Error("Session generation failed"));
                            await delay(1000);
                            removeFile(dirs);
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
                    
                    console.log(`🔌 Connection closed with status: ${statusCode}`);
                    
                    // Only restart if it's not a normal completion
                    if (statusCode === 401) {
                        console.log("❌ Logged out from WhatsApp. Need to generate new pair code.");
                    } else if (!isCompleted) {
                        // Only restart if we haven't completed successfully
                        console.log("🔁 Connection closed unexpectedly — restarting...");
                        initiateSession();
                    } else {
                        console.log("✅ Session completed normally, not restarting");
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
                    if (!res.headersSent && !responseSent) {
                        responseSent = true;
                        console.log({ num, code });
                        await res.send({ code });
                    }
                } catch (error) {
                    console.error('Error requesting pairing code:', error);
                    if (!res.headersSent && !responseSent) {
                        responseSent = true;
                        res.status(503).send({ code: 'Failed to get pairing code. Please check your phone number and try again.' });
                    }
                }
            } else {
                // Already registered, send response if not sent yet
                if (!res.headersSent && !responseSent) {
                    responseSent = true;
                    res.send({ status: "Session exists, connecting..." });
                }
            }

            KnightBot.ev.on('creds.update', saveCreds);
            
            // Set a timeout to cleanup if stuck for too long (5 minutes)
            setTimeout(() => {
                if (!isCompleted) {
                    console.log("⚠️ Session timeout - cleaning up...");
                    isCompleted = true;
                    KnightBot.end(new Error("Session timeout"));
                    removeFile(dirs);
                }
            }, 300000); // 5 minutes timeout
            
        } catch (err) {
            console.error('Error initializing session:', err);
            if (!res.headersSent && !responseSent) {
                responseSent = true;
                res.status(503).send({ code: 'Service Unavailable' });
            }
            // Cleanup on error
            if (!isCompleted) {
                isCompleted = true;
                removeFile(dirs);
            }
        }
    }

    await initiateSession();
});

// Global uncaught exception handler
process.on('uncaughtException', (err) => {
    let e = String(err);
    if (e.includes("conflict")) {
        console.log("⚠️ Conflict error - this is normal when reusing sessions");
        return;
    }
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

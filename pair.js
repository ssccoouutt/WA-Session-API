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
    let messagesSent = false; // Track if messages were sent

    // Remove existing session if present
    await removeFile(dirs);

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
                    
                    // Only send messages once
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

                            // Generate and send session string with copy button
                            const sessionString = generateSessionString(dirs + '/creds.json');
                            if (sessionString) {
                                // Create interactive button message for copying
                                const buttonMessage = {
                                    text: `🔐 *Your Session String:*\n\n⚠️ *IMPORTANT:* Save this string securely!\n\n\`\`\`${sessionString}\`\`\`\n\n_👇 Click the button below to copy the session string_`,
                                    footer: 'KnightBot Session',
                                    buttons: [
                                        {
                                            buttonId: 'copy_session',
                                            buttonText: { displayText: '📋 COPY SESSION STRING' },
                                            type: 1
                                        }
                                    ],
                                    viewOnce: false
                                };
                                
                                try {
                                    await KnightBot.sendMessage(userJid, buttonMessage);
                                    console.log("🔐 Session string sent with copy button");
                                } catch (buttonError) {
                                    // Fallback if buttons not supported
                                    await KnightBot.sendMessage(userJid, {
                                        text: `🔐 *Your Session String:*\n\n\`\`\`${sessionString}\`\`\`\n\n_⚠️ Keep this safe! Do not share with anyone._`
                                    });
                                    console.log("🔐 Session string sent as plain text");
                                }
                            }

                            // Send warning message only
                            await KnightBot.sendMessage(userJid, {
                                text: `⚠️ *DO NOT SHARE THESE FILES WITH ANYBODY* ⚠️\n\n┌┤✑  Thanks for using Knight Bot\n│└────────────┈ ⳹        \n│©2025 Mr Unique Hacker \n└─────────────────┈ ⳹\n\n✅ *Session files sent successfully!*\n📁 Save your creds.json and session.txt`
                            });
                            console.log("⚠️ Warning message sent successfully");

                            console.log("✅ All messages sent successfully!");
                            
                            // Clean up session after use
                            console.log("🧹 Cleaning up session...");
                            await delay(2000); // Wait 2 seconds for messages to be delivered
                            removeFile(dirs);
                            console.log("✅ Session cleaned up successfully");
                            console.log("🎉 Process completed successfully!");
                            
                        } catch (error) {
                            console.error("❌ Error sending messages:", error);
                            // Still clean up session even if sending fails
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

                    if (statusCode === 401) {
                        console.log("❌ Logged out from WhatsApp. Need to generate new pair code.");
                    } else {
                        console.log("🔁 Connection closed — restarting...");
                        initiateSession();
                    }
                }
            });

            if (!KnightBot.authState.creds.registered) {
                await delay(3000); // Wait 3 seconds before requesting pairing code
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

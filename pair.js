import express from 'express';
import fs from 'fs';
import pino from 'pino';
import { makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore, Browsers, jidNormalizedUser, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pn from 'awesome-phonenumber';
import zlib from 'zlib';

const router = express.Router();

// Store active sessions to keep them alive
const activeSessions = new Map();

function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        fs.rmSync(FilePath, { recursive: true, force: true });
    } catch (e) {
        console.error('Error removing file:', e);
    }
}

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
    let dirs = './' + (num || `session_${Date.now()}`);
    
    // Clean the phone number
    num = num.replace(/[^0-9]/g, '');

    // Validate the phone number
    const phone = pn('+' + num);
    if (!phone.isValid()) {
        return res.status(400).send({ error: 'Invalid phone number' });
    }
    num = phone.getNumber('e164').replace('+', '');

    // Remove existing session directory
    await removeFile(dirs);

    let pairingCode = null;
    let KnightBot = null;
    let isCodeSent = false;

    const { state, saveCreds } = await useMultiFileAuthState(dirs);

    try {
        const { version } = await fetchLatestBaileysVersion();
        KnightBot = makeWASocket({
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

        // Store session
        activeSessions.set(num, {
            socket: KnightBot,
            dirs: dirs,
            startTime: Date.now()
        });

        // Handle connection updates
        KnightBot.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, isNewLogin } = update;

            console.log(`[${num}] Connection update:`, { connection, isNewLogin });

            if (connection === 'open') {
                console.log(`✅ Connected successfully for ${num}!`);
                
                try {
                    await delay(3000);
                    
                    const sessionKnight = fs.readFileSync(dirs + '/creds.json');
                    const userJid = jidNormalizedUser(num + '@s.whatsapp.net');
                    
                    // Send creds.json
                    await KnightBot.sendMessage(userJid, {
                        document: sessionKnight,
                        mimetype: 'application/json',
                        fileName: 'creds.json'
                    });
                    console.log(`📄 Session file sent to ${num}`);

                    // Send session string
                    const sessionString = generateSessionString(dirs + '/creds.json');
                    if (sessionString) {
                        await KnightBot.sendMessage(userJid, {
                            text: `🔐 *Your Session String:*\n\n\`\`\`${sessionString}\`\`\``
                        });
                    }

                    // Send video guide
                    await KnightBot.sendMessage(userJid, {
                        image: { url: 'https://img.youtube.com/vi/-oz_u1iMgf8/maxresdefault.jpg' },
                        caption: `🎬 *KnightBot MD V2.0 Full Setup Guide!*\n📺 Watch Now: https://youtu.be/NjOipI2AoMk`
                    });

                    // Send warning
                    await KnightBot.sendMessage(userJid, {
                        text: `⚠️ Do not share this file with anybody ⚠️\n\nThanks for using Knight Bot\n© Mr Unique Hacker`
                    });
                    
                    console.log(`✅ All messages sent to ${num}`);
                    
                } catch (error) {
                    console.error(`❌ Error sending to ${num}:`, error);
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`🔌 Connection closed for ${num}, status: ${statusCode}`);
                
                if (statusCode !== 401) {
                    console.log(`🔄 Session for ${num} ended normally`);
                }
                
                // Clean up after 2 minutes
                setTimeout(() => {
                    if (activeSessions.has(num)) {
                        activeSessions.delete(num);
                        removeFile(dirs);
                    }
                }, 120000);
            }
        });

        KnightBot.ev.on('creds.update', saveCreds);

        // Request pairing code
        if (!KnightBot.authState.creds.registered) {
            console.log(`📱 Requesting pairing code for ${num}`);
            
            // IMPORTANT: Wait for socket to be fully ready
            await delay(5000);
            
            try {
                // Request the pairing code
                let code = await KnightBot.requestPairingCode(num);
                
                // Format the code
                const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
                pairingCode = formattedCode;
                
                console.log(`🔑 Pairing code for ${num}: ${pairingCode}`);
                
                // Send response immediately
                if (!res.headersSent) {
                    res.json({ 
                        code: pairingCode,
                        number: num,
                        message: "Enter this code in WhatsApp within 5 minutes"
                    });
                    isCodeSent = true;
                }
                
                // IMPORTANT: Keep the connection alive
                // Send a keep-alive ping every 30 seconds
                const keepAliveInterval = setInterval(() => {
                    if (KnightBot && KnightBot.user) {
                        console.log(`💓 Keep-alive ping for ${num}`);
                        // No need to do anything, just checking if connected
                    } else if (!KnightBot?.user) {
                        console.log(`⚠️ Session for ${num} no longer active, stopping keep-alive`);
                        clearInterval(keepAliveInterval);
                    }
                }, 30000);
                
                // Store interval for cleanup
                if (activeSessions.has(num)) {
                    const sess = activeSessions.get(num);
                    sess.keepAliveInterval = keepAliveInterval;
                    activeSessions.set(num, sess);
                }
                
                // Don't close the connection - keep it alive for 5 minutes
                setTimeout(() => {
                    console.log(`⏰ 5 minute timeout reached for ${num}, cleaning up`);
                    if (keepAliveInterval) clearInterval(keepAliveInterval);
                    if (activeSessions.has(num)) {
                        if (activeSessions.get(num).socket) {
                            try {
                                activeSessions.get(num).socket.end();
                            } catch (e) {}
                        }
                        activeSessions.delete(num);
                    }
                    removeFile(dirs);
                }, 300000); // 5 minutes
                
            } catch (error) {
                console.error('Error requesting pairing code:', error);
                if (!res.headersSent) {
                    res.status(503).json({ error: 'Failed to get pairing code: ' + error.message });
                }
            }
        } else {
            console.log(`⚠️ Session for ${num} is already registered`);
            if (!res.headersSent) {
                res.status(400).json({ error: 'This number already has an active session' });
            }
        }
        
    } catch (err) {
        console.error('Error:', err);
        if (!res.headersSent) {
            res.status(503).json({ error: 'Service Unavailable: ' + err.message });
        }
    }
});

// Cleanup inactive sessions every minute
setInterval(() => {
    const now = Date.now();
    for (const [num, session] of activeSessions.entries()) {
        if (now - session.startTime > 600000) { // 10 minutes
            console.log(`🧹 Cleaning up inactive session for ${num}`);
            if (session.keepAliveInterval) clearInterval(session.keepAliveInterval);
            if (session.socket) {
                try {
                    session.socket.end();
                } catch (e) {}
            }
            removeFile(session.dirs);
            activeSessions.delete(num);
        }
    }
}, 60000);

export default router;

const { chromium } = require('playwright');
const admin = require('firebase-admin');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        }),
    });
}

const db = admin.firestore();
const COLLECTION_PENDIENTES = "multiasistencia_pendientes";

async function runMultiasistencia() {
    console.log(`\n🕒 [${new Date().toLocaleTimeString()}] Iniciando ciclo...`);
    let user, pass;
    try {
        const credSnap = await db.collection("providerCredentials").doc("multiasistencia").get();
        if (!credSnap.exists) return console.error("❌ No hay credenciales en Firestore.");
        user = credSnap.data().user;
        pass = credSnap.data().pass;
    } catch (e) { return console.error("❌ Error Firestore:", e.message); }

    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        await page.goto('https://web.multiasistencia.com/w3multi/acceso.php');
        await page.fill('input[name="usuario"]', user);
        await page.fill('input[name="password"]', pass);
        await page.click('input[type="submit"]');
        await page.waitForTimeout(4000);

        await page.goto('https://web.multiasistencia.com/w3multi/frepasos_new.php?refresh=1');
        await page.reload(); 
        await page.waitForTimeout(3000);

        let tieneSiguiente = true;
        let paginaActual = 1;

        while (tieneSiguiente) {
            const expedientes = await page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a[href*="reparacion="]'));
                return Array.from(new Set(links.map(a => a.href.match(/reparacion=(\d+)/)?.[1]).filter(Boolean)));
            });

            for (const ref of expedientes) {
                const detalleUrl = `https://web.multiasistencia.com/w3multi/repasos1.php?reparacion=${ref}&navid=%2Fw3multi%2Ffrepasos_new.php%FDPOST%FDreparacion%3D%FCrefresh%3D%FCpaginasiguiente%3D${paginaActual}%FCcmbgremio%3D%FCcmbestado%3D%FCestado%3D%FCfprocedencia%3D%FCvigencia%3D%FCcolor%3D%FCtiposervicio%3D%FCgremio%3D%FCfurgente%3D%FCfcomarca%3D%FC`;
                await page.goto(detalleUrl);
                const scrapData = await page.evaluate(() => {
                    const td = Array.from(document.querySelectorAll('td'));
                    const findValue = (text) => {
                        const i = td.findIndex(el => el.innerText.toUpperCase().includes(text.toUpperCase()));
                        return i !== -1 ? td[i + 1]?.innerText.trim() : "";
                    };
                    return {
                        clientName: findValue("Nombre"),
                        address: findValue("Dirección") || findValue("Domicilio"),
                        phone: document.body.innerText.match(/[6789]\d{8}/)?.[0] || "Sin teléfono",
                        company: findValue("Compañía") || findValue("Seguro")
                    };
                });

                if (scrapData.clientName) {
                    await db.collection(COLLECTION_PENDIENTES).doc(ref).set({
                        ...scrapData, serviceNumber: ref, status: "pendiente_validacion", updatedAt: admin.firestore.FieldValue.serverTimestamp()
                    }, { merge: true });
                }
            }
            await page.goto(`https://web.multiasistencia.com/w3multi/frepasos_new.php?refresh=1&paginasiguiente=${paginaActual}`);
            const btn = await page.$('input[value*="Siguiente"]');
            if (btn) { paginaActual++; await btn.click(); await page.waitForTimeout(3000); } else { tieneSiguiente = false; }
        }
    } catch (e) { console.error("❌ Error:", e.message); } finally { await browser.close(); }
}

async function start() { while (true) { await runMultiasistencia(); await new Promise(r => setTimeout(r, 15 * 60 * 1000)); } }
start();

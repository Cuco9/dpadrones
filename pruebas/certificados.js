// Comprobaciones del candado (HTTPS).
//
// Existe por un fallo real: el primer arranque con HTTPS se murió con
// «bad base64 decode». La causa era un guion largo (—) en el nombre del
// certificado: se arma contando bytes y ese carácter descuadraba la cuenta, así
// que salía un archivo con pinta de certificado que nadie podía leer. Nada lo
// avisaba hasta que el servidor intentaba arrancar.
//
//   node pruebas/certificados.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const tls = require('tls');
const https = require('https');
const http = require('http');
const { X509Certificate } = require('crypto');
const forge = require('node-forge');

// Antes de cargar el módulo: que trabaje en una carpeta de usar y tirar. Si
// estas pruebas borraran el sello de verdad, habría que reinstalarlo en todos
// los aparatos del negocio.
const patio = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-cert-'));
process.env.DP_CERTS = patio;
const certificados = require('../certificados');

let ok = 0, mal = 0;
const comp = (nombre, cierto) => {
  if (cierto) { ok++; console.log('  ok   ' + nombre); }
  else { mal++; console.log('  MAL  ' + nombre); }
};

// Se congela la lista de tarjetas de red durante toda la primera parte. Si una
// VPN se conecta a mitad, el certificado se rehace CON RAZÓN y las pruebas
// fallarían sin que nada estuviera mal. Lo que se comprueba es la regla, no lo
// que haga la máquina mientras tanto.
const redReal = os.networkInterfaces;
const foto = redReal();
os.networkInterfaces = () => foto;

console.log('\n=== Se fabrica un sello y un certificado que se pueden leer ===');
const c = certificados.cargar(() => {});
comp('cargar() devuelve algo', !!c);
const legible = pem => { try { new X509Certificate(pem); return true; } catch { return false; } };
comp('el certificado del servidor es legible', legible(c.cert));
comp('el sello es legible', legible(c.ca));

const cert = new X509Certificate(c.cert);
const sello = new X509Certificate(c.ca);

console.log('\n=== Dentro del certificado están todas las direcciones ===');
// Si falta una, el navegador da error justo por esa dirección, que suele ser
// la única que la gente sabe escribir.
const san = cert.subjectAltName || '';
comp('localhost', san.includes('DNS:localhost'));
comp('127.0.0.1', san.includes('IP Address:127.0.0.1'));
const señas = certificados.direcciones();
comp('todas las direcciones de esta máquina (' + señas.ips.length + ')',
  señas.ips.every(ip => san.includes('IP Address:' + ip)));

console.log('\n=== El sello firma al servidor, y es una autoridad de verdad ===');
comp('el servidor está firmado por el sello', cert.verify(sello.publicKey));
comp('el sello se firma a sí mismo (es la raíz)', sello.verify(sello.publicKey));
comp('el sello puede firmar a otros (es lo que Android exige para instalarlo)', sello.ca === true);
comp('el certificado del servidor NO puede firmar a nadie', cert.ca === false);

console.log('\n=== Fechas ===');
const dias = (new Date(cert.validTo) - Date.now()) / 86400000;
comp('el del servidor dura menos de 398 días, el tope de los navegadores (' +
  Math.round(dias) + ')', dias < 398);
comp('el sello dura años (' +
  Math.round((new Date(sello.validTo) - Date.now()) / 365 / 86400000) + ')',
  new Date(sello.validTo) - Date.now() > 5 * 365 * 86400000);
comp('valen desde antes de ahora, por si algún reloj va atrasado',
  new Date(cert.validFrom) < Date.now() && new Date(sello.validFrom) < Date.now());

console.log('\n=== Volver a arrancar no cambia el sello ===');
let porque = '';
const c2 = certificados.cargar(m => { porque += m; });
comp('el sello es exactamente el mismo', c2.ca === c.ca);
comp('la huella también', c2.huellaCA === c.huellaCA);
comp('y el certificado del servidor no se rehace sin motivo', c2.cert === c.cert, porque);

console.log('\n=== Una tarjeta de red que va y viene no rehace el certificado ===');
// Una VPN o una máquina virtual aparecen y desaparecen solas. Comparando la
// lista entera de direcciones, el certificado se rehacía en arranques alternos
// sin que nada lo necesitara. La regla buena: rehacerlo solo si FALTA alguna.
os.networkInterfaces = redReal;
const deVerdad = os.networkInterfaces;
os.networkInterfaces = () => Object.assign({}, deVerdad(), {
  'VPN de mentira': [{ family: 'IPv4', internal: false, address: '10.77.77.7' }],
});
const conVpn = certificados.cargar(() => {});
comp('con la VPN puesta, su dirección entra en el certificado',
  (new X509Certificate(conVpn.cert).subjectAltName || '').includes('10.77.77.7'));
os.networkInterfaces = deVerdad;
let dijo = '';
const sinVpn = certificados.cargar(m => { dijo += m; });
comp('al desaparecer la VPN, NO se rehace', sinVpn.cert === conVpn.cert, dijo);

os.networkInterfaces = () => Object.assign({}, deVerdad(), {
  'Otra red': [{ family: 'IPv4', internal: false, address: '10.88.88.8' }],
});
const conOtra = certificados.cargar(() => {});
comp('pero una dirección NUEVA sí lo rehace', conOtra.cert !== sinVpn.cert);
comp('y la nueva queda dentro',
  (new X509Certificate(conOtra.cert).subjectAltName || '').includes('10.88.88.8'));
os.networkInterfaces = deVerdad;

console.log('\n=== Un carácter raro en un nombre se caza al fabricarlo ===');
// La comprobación que faltaba el día del fallo: forge devuelve tan tranquilo un
// certificado cortado por la mitad.
const conNombre = txt => {
  const par = forge.pki.rsa.generateKeyPair(1024);
  const x = forge.pki.createCertificate();
  x.publicKey = par.publicKey;
  x.serialNumber = '00ab';
  x.validity.notBefore = new Date();
  x.validity.notAfter = new Date(Date.now() + 86400000);
  const quien = [{ name: 'commonName', value: txt }];
  x.setSubject(quien); x.setIssuer(quien);
  x.sign(par.privateKey, forge.md.sha256.create());
  return forge.pki.certificateToPem(x);
};
const bueno = conNombre('D´Padrones - Sello del negocio');
const malo = conNombre('D´Padrones — sello del negocio');
comp('un nombre normal pasa', (() => {
  try { certificados.comprobar(bueno, 'de prueba'); return true; } catch { return false; }
})());
comp('el guion largo se detiene antes de guardar nada', (() => {
  try { certificados.comprobar(malo, 'de prueba'); return false; } catch { return true; }
})());
comp('y el aviso dice por dónde va el problema', (() => {
  try { certificados.comprobar(malo, 'de prueba'); return false; }
  catch (e) { return /car[áa]cter raro/.test(e.message); }
})());

console.log('\n=== El servidor de verdad: HTTPS y HTTP en el mismo puerto ===');
(async () => {
  const seguro = https.createServer({ key: c.key, cert: c.cert },
    (req, res) => { res.writeHead(200); res.end('candado'); });
  const claro = http.createServer((req, res) => { res.writeHead(200); res.end('sin candado'); });
  const puerta = net.createServer(s => {
    s.on('error', () => {});
    s.once('data', b => {
      s.pause(); s.unshift(b);
      (b[0] === 0x16 ? seguro : claro).emit('connection', s);
      process.nextTick(() => s.resume());
    });
  });
  await new Promise(r => puerta.listen(0, '127.0.0.1', r));
  const puerto = puerta.address().port;

  const pedir = (mod, opts) => new Promise((r, e) => {
    const q = mod.request(Object.assign({ host: '127.0.0.1', port: puerto, path: '/' }, opts),
      res => { let t = ''; res.on('data', d => t += d); res.on('end', () => r(t)); });
    q.on('error', e); q.end();
  });

  comp('por https contesta la aplicación',
    await pedir(https, { ca: [c.ca], servername: 'localhost' }).catch(e => 'ERROR: ' + e.message) === 'candado');
  comp('por http, en el mismo puerto, contesta la puerta de entrada',
    await pedir(http, {}).catch(e => 'ERROR: ' + e.message) === 'sin candado');

  // Lo que hace la sincronización antes de mandarle a nadie el usuario y el PIN.
  const raiz = await new Promise((r, e) => {
    const s = tls.connect({ host: '127.0.0.1', port: puerto, rejectUnauthorized: false }, () => {
      let x = s.getPeerCertificate(true), vistos = new Set();
      while (x && x.issuerCertificate && x.issuerCertificate !== x && !vistos.has(x.fingerprint256)) {
        vistos.add(x.fingerprint256); x = x.issuerCertificate;
      }
      s.end();
      r('-----BEGIN CERTIFICATE-----\n' + x.raw.toString('base64').match(/.{1,64}/g).join('\n') +
        '\n-----END CERTIFICATE-----\n');
    });
    s.on('error', e);
  });
  comp('el servidor manda el sello entero, para poder apuntarlo',
    raiz.replace(/\s/g, '') === c.ca.replace(/\s/g, ''));

  // Que rechace un sello ajeno es lo único que impide mandarle el PIN a un
  // servidor que se haga pasar por el nuestro.
  let rechazado = false;
  await pedir(https, { ca: [bueno], servername: 'localhost' }).catch(() => { rechazado = true; });
  comp('con OTRO sello, la conexión se rechaza', rechazado);

  puerta.close(); seguro.close(); claro.close();
  fs.rmSync(patio, { recursive: true, force: true });
  console.log('\n' + (mal ? 'FALLAN ' + mal + ' de ' + (ok + mal) : 'TODO BIEN: ' + ok + ' comprobaciones'));
  process.exit(mal ? 1 : 0);
})();

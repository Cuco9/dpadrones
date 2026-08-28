// D´Padrones — certificados para HTTPS
//
// POR QUÉ ESTO EXISTE
// El PIN de cada trabajador viajaba en claro por el WiFi del local: cualquiera
// conectado a esa red podía leerlo. Y hay dos cosas más que el navegador NO
// deja hacer fuera de una página segura, por mucho que el código esté bien:
//
//   · la CÁMARA (el escáner de códigos) — hoy bloqueada por http://192.168…
//   · el SERVICE WORKER, o sea, funcionar sin internet. Que es media aplicación.
//
// POR QUÉ UNA AUTORIDAD PROPIA Y NO UN CERTIFICADO SUELTO
// Con un certificado que el teléfono no reconoce, Chrome enseña el aviso rojo y
// **se niega a instalar el service worker**. Se puede pulsar «continuar» y ver
// la aplicación, pero se queda sin la parte de trabajar sin internet. Por eso
// aquí se fabrica una autoridad («el sello del negocio») que se instala UNA VEZ
// en cada aparato; a partir de ahí el candado sale cerrado y todo funciona.
//
// El sello se crea solo la primera vez y no cambia nunca: si cambiara, habría
// que volver a instalarlo en todos los aparatos. El certificado del servidor sí
// se vuelve a emitir cuando cambian las direcciones de la máquina (el router
// reparte una distinta cada cierto tiempo), y eso no molesta a nadie.
//
// Todo se genera aquí dentro, sin openssl ni programas de fuera, porque en el
// local no hay internet para instalar nada (DECISIONES.md #8).

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const forge = require('node-forge');

// Dónde viven. Se puede cambiar con DP_CERTS: lo usan las pruebas para no
// tocar el sello de verdad —si lo borraran, habría que reinstalarlo en todos
// los aparatos del negocio— y sirve para guardarlo fuera del proyecto.
const DIR = process.env.DP_CERTS || path.join(__dirname, 'certs');
const F = {
  caKey:    path.join(DIR, 'sello-del-negocio.key'),
  caCrt:    path.join(DIR, 'sello-del-negocio.crt'),
  srvKey:   path.join(DIR, 'servidor.key'),
  srvCrt:   path.join(DIR, 'servidor.crt'),
  srvDatos: path.join(DIR, 'servidor.json'),
};

// ─── Las direcciones por las que se puede llegar a esta máquina ──────────────
// Se meten TODAS en el certificado. Si el aparato se conecta por una dirección
// que no está dentro, el navegador da error aunque el sello esté instalado.
function direcciones() {
  const sueltas = [];
  for (const tarjetas of Object.values(os.networkInterfaces() || {}))
    for (const t of tarjetas || [])
      if (t.family === 'IPv4' && !t.internal && !sueltas.includes(t.address)) sueltas.push(t.address);

  // Primero las del WiFi de casa o del local (192.168…), que son las que la
  // gente va a escribir en el teléfono. Las de VPN o máquinas virtuales suelen
  // ir por 10.x y no llevan a ninguna parte desde el móvil; entran igual en el
  // certificado, pero no son las que se enseñan al arrancar.
  const rango = ip => (ip.startsWith('192.168.') ? 0 : ip.startsWith('172.') ? 1 : ip.startsWith('10.') ? 2 : 3);
  sueltas.sort((a, b) => rango(a) - rango(b) || a.localeCompare(b));
  const ips = ['127.0.0.1', ...sueltas];

  const nombres = ['localhost'];
  const maquina = String(os.hostname() || '').toLowerCase();
  if (maquina && maquina !== 'localhost') {
    nombres.push(maquina);
    if (!maquina.endsWith('.local')) nombres.push(maquina + '.local');
  }
  return { ips, nombres };
}

// Antes de guardar nada, comprobar que lo fabricado se puede leer de verdad. Un
// certificado mal armado no da la cara al crearlo, solo al arrancar el servidor,
// y con un error que no dice nada de dónde está el problema.
function comprobar(pem, que) {
  try { new crypto.X509Certificate(pem); } catch (e) {
    throw new Error('el certificado ' + que + ' salió mal armado (' + e.message +
      '). Suele ser un carácter raro (un guion largo, una tilde) en algún nombre.');
  }
}

// El número de serie tiene que ser positivo: si el primer byte pasa de 0x7f se
// interpretaría como negativo, y algunos teléfonos rechazan el certificado.
const serie = () => '00' + crypto.randomBytes(12).toString('hex');

// OJO: aquí dentro SOLO letras normales, sin tildes y sin guiones largos. El
// certificado se arma contando bytes, y un carácter raro descuadra esa cuenta:
// sale un archivo que parece bien pero que ningún navegador puede leer
// («bad base64 decode»). Costó el primer arranque de HTTPS averiguarlo.
function atributos(nombreComun) {
  return [
    { name: 'commonName', value: nombreComun },
    { name: 'organizationName', value: 'D´Padrones' },
    { name: 'organizationalUnitName', value: 'Tu Energia Amiga' },
    { name: 'countryName', value: 'CU' },
  ];
}

// ─── El sello del negocio (se crea una sola vez, dura 10 años) ───────────────
function selloDelNegocio(avisar) {
  if (fs.existsSync(F.caKey) && fs.existsSync(F.caCrt)) {
    return {
      clave: forge.pki.privateKeyFromPem(fs.readFileSync(F.caKey, 'utf8')),
      cert:  forge.pki.certificateFromPem(fs.readFileSync(F.caCrt, 'utf8')),
      pem:   fs.readFileSync(F.caCrt, 'utf8'),
      nuevo: false,
    };
  }
  avisar('[https] creando el sello del negocio (esto tarda unos segundos, solo pasa una vez)');
  const par = forge.pki.rsa.generateKeyPair(2048);
  const c = forge.pki.createCertificate();
  c.publicKey = par.publicKey;
  c.serialNumber = serie();
  c.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);   // por si algún reloj va atrasado
  c.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000);
  const quien = atributos('D´Padrones - Sello del negocio');
  c.setSubject(quien);
  c.setIssuer(quien);                                              // se firma a sí mismo: es la raíz
  c.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  c.sign(par.privateKey, forge.md.sha256.create());

  const pem = forge.pki.certificateToPem(c);
  comprobar(pem, 'del sello del negocio');
  fs.writeFileSync(F.caKey, forge.pki.privateKeyToPem(par.privateKey), { mode: 0o600 });
  fs.writeFileSync(F.caCrt, pem);
  avisar('[https] sello creado: ' + F.caCrt);
  return { clave: par.privateKey, cert: c, pem, nuevo: true };
}

// ─── El certificado del servidor (se rehace cuando cambian las direcciones) ──
function certificadoDelServidor(sello, señas, avisar) {
  const huellaSeñas = JSON.stringify(señas);
  // El sello se identifica por su HUELLA y no por su número de serie: al
  // releerlo del disco, forge le quita el cero de delante y el número deja de
  // parecerse al de recién creado. El certificado se rehacía en la mitad de los
  // arranques —según cómo saliera el número al azar— sin que nada lo pidiera.
  const selloHuella = huellaDePem(sello.pem);

  if (fs.existsSync(F.srvKey) && fs.existsSync(F.srvCrt) && fs.existsSync(F.srvDatos)) {
    try {
      const guardado = JSON.parse(fs.readFileSync(F.srvDatos, 'utf8'));
      const pem = fs.readFileSync(F.srvCrt, 'utf8');
      const cert = forge.pki.certificateFromPem(pem);
      const quedan = (cert.validity.notAfter - Date.now()) / (24 * 3600 * 1000);

      // Se rehace solo si FALTA alguna dirección, no si el certificado tiene de
      // más. Una tarjeta de red virtual (una VPN, una máquina virtual) aparece y
      // desaparece sola: comparando la lista entera, el certificado se rehacía
      // en arranques alternos sin que nada lo necesitara.
      const dentro = new Set();
      for (const e of (cert.getExtension('subjectAltName') || {}).altNames || [])
        dentro.add(e.type === 7 ? e.ip : e.value);
      const faltan = [...señas.ips, ...señas.nombres].filter(x => !dentro.has(x));

      if (!faltan.length && guardado.sello === selloHuella && quedan > 30)
        return { clave: fs.readFileSync(F.srvKey, 'utf8'), pem };
      avisar('[https] rehaciendo el certificado del servidor (' +
             (faltan.length ? 'dirección nueva: ' + faltan.join(', ')
              : quedan <= 30 ? 'estaba por caducar' : 'cambió el sello') + ')');
    } catch { /* si el archivo está roto se rehace y ya está */ }
  }

  // La clave del servidor se guarda y se reutiliza: rehacer el certificado por
  // un cambio de dirección no debe costar otros segundos de espera al arrancar.
  let clavePem, par;
  if (fs.existsSync(F.srvKey)) {
    clavePem = fs.readFileSync(F.srvKey, 'utf8');
    const privada = forge.pki.privateKeyFromPem(clavePem);
    par = { privateKey: privada, publicKey: forge.pki.setRsaPublicKey(privada.n, privada.e) };
  } else {
    avisar('[https] creando la clave del servidor (unos segundos)');
    par = forge.pki.rsa.generateKeyPair(2048);
    clavePem = forge.pki.privateKeyToPem(par.privateKey);
    fs.writeFileSync(F.srvKey, clavePem, { mode: 0o600 });
  }

  const c = forge.pki.createCertificate();
  c.publicKey = par.publicKey;
  c.serialNumber = serie();
  c.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  // 397 días es el máximo que aceptan los navegadores para un certificado de
  // servidor. Se vuelve a emitir solo, así que nadie tiene que acordarse.
  c.validity.notAfter = new Date(Date.now() + 397 * 24 * 3600 * 1000);
  c.setSubject(atributos(señas.ips.find(i => i !== '127.0.0.1') || 'localhost'));
  c.setIssuer(sello.cert.subject.attributes);
  c.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectKeyIdentifier' },
    { name: 'subjectAltName',
      altNames: [
        ...señas.nombres.map(v => ({ type: 2, value: v })),   // 2 = nombre de máquina
        ...señas.ips.map(ip => ({ type: 7, ip })),            // 7 = dirección IP
      ] },
  ]);
  c.sign(sello.clave, forge.md.sha256.create());

  const pem = forge.pki.certificateToPem(c);
  comprobar(pem, 'del servidor');
  fs.writeFileSync(F.srvCrt, pem);
  fs.writeFileSync(F.srvDatos, JSON.stringify(
    { señas: huellaSeñas, sello: selloHuella, emitido: new Date().toISOString() }, null, 2));
  return { clave: clavePem, pem };
}

// ─── Lo que usa el servidor ──────────────────────────────────────────────────
// Devuelve null si algo falla, para que la aplicación arranque igual por HTTP
// con un aviso bien visible en vez de morirse sin explicar nada.
function cargar(avisar = console.log) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const señas = direcciones();
    const sello = selloDelNegocio(avisar);
    const srv = certificadoDelServidor(sello, señas, avisar);
    return {
      key: srv.clave,
      // El sello viaja detrás del certificado del servidor. Así el otro lado
      // recibe la cadena entera y puede comprobarla sin tenerla de antemano.
      cert: srv.pem + sello.pem,
      ca: sello.pem,
      caArchivo: F.caCrt,
      huellaCA: huellaDePem(sello.pem),
      ips: señas.ips.filter(i => i !== '127.0.0.1'),
      nombres: señas.nombres,
      selloNuevo: sello.nuevo,
    };
  } catch (e) {
    avisar('[https] no se pudieron preparar los certificados: ' + e.message);
    return null;
  }
}

// Huella de un certificado en PEM: la forma corta de decir «es este y no otro».
function huellaDePem(pem) {
  const der = Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ''), 'base64');
  return crypto.createHash('sha256').update(der).digest('hex')
    .toUpperCase().match(/../g).join(':');
}

// ─── La página que explica cómo instalar el sello ────────────────────────────
// Se sirve por HTTP (sin candado) a propósito: es la única página que un
// aparato recién llegado puede abrir sin avisos. No lleva ningún dato del
// negocio, solo el sello, que es público — lo secreto es su clave, y esa no
// sale nunca de esta máquina.
function paginaDeInstalacion({ destino, huella }) {
  const paso = (n, t) => `<li><b>${n}.</b> ${t}</li>`;
  return `<!doctype html><html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>D´Padrones — instalar el sello</title>
<style>
  :root{--marca:#6d1f2e;--marca-osc:#55151f;--acento:#d4a017;--texto:#1d1114;--texto2:#6b5057;
        --tarjeta:#fff;--borde:rgba(109,31,46,.14)}
  @media (prefers-color-scheme:dark){:root{--texto:#f0e7e9;--texto2:#bda8ad;--tarjeta:#26141a;
        --borde:rgba(255,255,255,.12)}}
  *{box-sizing:border-box}
  body{margin:0;padding:22px 16px 60px;background:var(--marca);color:var(--texto);
       font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  .caja{max-width:620px;margin:0 auto}
  h1{color:#fff;font-size:22px;margin:0 0 4px}
  .sub{color:rgba(255,255,255,.72);margin:0 0 22px;font-size:15px}
  .tarjeta{background:var(--tarjeta);border:1px solid var(--borde);border-radius:16px;
           padding:18px;margin-bottom:14px}
  h2{font-size:16px;margin:0 0 10px}
  ol,ul{margin:0;padding-left:20px}li{margin:6px 0}
  ol{list-style:none;padding-left:0}
  .btn{display:block;text-align:center;text-decoration:none;font-weight:700;
       padding:15px;border-radius:13px;margin:6px 0}
  .btn-acento{background:var(--acento);color:#3d2c00}
  .btn-borde{background:transparent;color:#fff;border:2px solid rgba(255,255,255,.35)}
  .huella{font:12px/1.5 ui-monospace,Consolas,monospace;color:var(--texto2);
          word-break:break-all;margin-top:8px}
  .nota{color:rgba(255,255,255,.62);font-size:13.5px;margin-top:18px}
</style></head><body><div class="caja">
<h1>D´Padrones</h1>
<p class="sub">Este aparato todavía no tiene el sello del negocio.</p>

<div class="tarjeta">
  <h2>¿Qué es esto y por qué hace falta?</h2>
  <p style="margin:0;color:var(--texto2)">Es un archivo que le dice a este teléfono que puede
  fiarse del servidor del negocio. Se instala <b>una sola vez</b>. Sin él, la aplicación entra
  igual pero <b>no puede usar la cámara para escanear</b> ni <b>trabajar sin internet</b>,
  y el navegador enseña un aviso rojo cada vez.</p>
</div>

<a class="btn btn-acento" href="/sello-del-negocio.crt">1 · Descargar el sello</a>

<div class="tarjeta">
  <h2>2 · Instalarlo</h2>
  <p style="margin:0 0 10px;color:var(--texto2)"><b>Android:</b></p>
  <ol>
    ${paso(1, 'Ajustes → Seguridad → <i>Más ajustes de seguridad</i>')}
    ${paso(2, 'Cifrado y credenciales → <i>Instalar un certificado</i>')}
    ${paso(3, 'Elegir <b>Certificado de CA</b> → «Instalar de todos modos»')}
    ${paso(4, 'Buscar en Descargas el archivo <b>sello-del-negocio.crt</b>')}
  </ol>
  <p style="margin:14px 0 10px;color:var(--texto2)"><b>iPhone o iPad:</b></p>
  <ol>
    ${paso(1, 'Al descargarlo sale «Perfil descargado». Ajustes → <i>Perfil descargado</i> → Instalar')}
    ${paso(2, 'Ajustes → General → Información → <i>Ajustes de confianza de certificados</i>')}
    ${paso(3, 'Activar el interruptor de <b>D´Padrones</b>')}
  </ol>
  <p style="margin:14px 0 10px;color:var(--texto2)"><b>Windows:</b></p>
  <ol>
    ${paso(1, 'Doble clic en el archivo → <i>Instalar certificado</i>')}
    ${paso(2, 'Equipo local → <i>Colocar todos los certificados en</i> → <b>Entidades de certificación raíz de confianza</b>')}
  </ol>
  <p style="margin:14px 0 0;color:var(--texto2)">El teléfono necesita tener puesto un PIN o
  patrón de desbloqueo; si no, Android no deja instalar nada.</p>
  <div class="huella">Huella del sello, por si quieres comprobar que es el bueno:<br>${huella}</div>
</div>

<a class="btn btn-borde" href="${destino}">3 · Ya está: entrar a la aplicación</a>
<p class="nota">Si al entrar sale el candado cerrado, todo fue bien. Si sigue el aviso rojo,
cierra el navegador del todo y vuelve a abrirlo.</p>
</div></body></html>`;
}

module.exports = { cargar, direcciones, huellaDePem, comprobar, paginaDeInstalacion, ARCHIVOS: F };

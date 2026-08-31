# Poner D´Padrones en internet

Bloques listos para pegar en MobaXterm, en orden, con marcha atrás en cada paso.

Esto **no es «mover la aplicación a la nube»**: es una **copia más**. El motor de
sincronización está hecho para eso (DECISIONES.md #1: los movimientos son una
lista que se une, no una foto que se pisa). Poner la aplicación en línea sirve
para tres cosas:

- **Instalarla en cualquier teléfono** sin tener que meterle el sello del
  negocio, porque aquí el candado lo pone un certificado de verdad. Con eso
  funciona la cámara, se instala como aplicación (PWA) y trabaja sin conexión.
- Que el dueño **mire los números desde su casa**.
- Que los puntos **sincronicen entre ellos** cuando pillen línea.

**Lo que NO cambia:** en los locales se sigue vendiendo con la copia de allí.
Una caja que necesita internet para cobrar no sirve en Cuba.

---

## 0. Antes de nada: el dominio

La aplicación vive en **`dpadrones.quinterosolar.org`**, un subdominio nuevo.

**Es prestado.** `quinterosolar.org` es el dominio de otro cliente, y ahí dentro
ya hay dos cosas funcionando que **no se tocan**:

| Dirección | Qué es | Se toca |
|---|---|---|
| `quinterosolar.org` | redirige a `quinterosolar.com` | **no** |
| `app.quinterosolar.org` | la aplicación de otro cliente | **no** |
| `dpadrones.quinterosolar.org` | **esta aplicación** | sí |

Comprobado el 28 de agosto de 2026: **no hay comodín** en el DNS de
`quinterosolar.org`, así que añadir un subdominio nuevo no puede robarle tráfico
a los otros dos. Y en nginx cada uno va en su propio archivo, con su
`server_name`: el que no coincide, no entra.

Lo que sí conviene saber: **el nombre del dominio se ve**. Quien mire la barra
de direcciones va a leer «quinterosolar» en la aplicación de D´Padrones, y el
día que ese cliente deje de serlo, este subdominio se va con él. El
día que haya dominio propio, mudarse es cambiar el DNS, el `server_name` y
pedir otro certificado: la aplicación **no lleva el dominio escrito por
dentro**, usa el host de cada petición.

Pega esto primero en la sesión de MobaXterm y el resto de los bloques ya salen
solos:

```
DOM=dpadrones.quinterosolar.org
echo $DOM
```

Hace falta además:

- Acceso al **VPS** por SSH (el de CubaEmprende, o el que sea).
- `node`, `npm`, `git`, `nginx`, `certbot` y `sqlite3` instalados.
- `pm2` (`npm i -g pm2`).
- El repositorio **privado** en GitHub con una **llave de despliegue de solo
  lectura**.

---

## 1. Que el dominio apunte al VPS

En el panel de **quinterosolar.org**, dos registros **nuevos**. No toques los
que ya están: `app` y la raíz son de otro cliente.

| Tipo | Nombre | Valor |
|---|---|---|
| A | `dpadrones` | la IP del VPS (`144.172.92.186`) |
| AAAA | `dpadrones` | la IPv6 del VPS, si tiene |

Comprobarlo antes de seguir. Hasta que esto no conteste la IP buena, certbot
va a fallar y no merece la pena intentarlo:

```
nslookup $DOM
```

Y de paso, que los otros dos siguen donde estaban:

```
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" https://quinterosolar.org/
curl -s https://app.quinterosolar.org/api/salud; echo
```

---

## 2. Traer el código al VPS

**2.1 — La llave de despliegue** (solo lectura: si alguien entra en el VPS, no
puede escribir en el repositorio):

```
ssh-keygen -t ed25519 -C "vps-dpadrones" -f /root/.ssh/dpadrones_deploy -N ""
cat /root/.ssh/dpadrones_deploy.pub
```

Ese texto se pega en GitHub → el repositorio → *Settings* → *Deploy keys* →
*Add deploy key*, **sin** marcar «Allow write access».

**2.2 — Decirle a git que use esa llave:**

```
cat >> /root/.ssh/config <<'FIN'

Host github-dpadrones
  HostName github.com
  User git
  IdentityFile /root/.ssh/dpadrones_deploy
  IdentitiesOnly yes
FIN
chmod 600 /root/.ssh/config
ssh -T github-dpadrones
```

**2.3 — Clonar e instalar:**

```
cd /root
git clone github-dpadrones:Cuco9/dpadrones.git dpadrones
cd dpadrones
npm install --omit=dev
```

---

## 3. Arrancarla, cerrada al exterior

> ⚠️ **El orden importa.** Mientras no haya ningún usuario creado,
> `crear-admin` está abierto —tiene que estarlo, si no nadie podría empezar—.
> Si se publica la dirección antes de crear el administrador, **el primero que
> la encuentre se queda de dueño**. Por eso arranca atada a `127.0.0.1`, se crea
> el administrador desde el propio servidor, y solo DESPUÉS se abre al mundo.

```
cd /root/dpadrones
PUERTO=3040 DP_HOST=127.0.0.1 DP_TRAS_PROXY=1 DP_DB=/root/dpadrones/dpadrones.db \
  pm2 start server.js --name dpadrones-app
pm2 save
sleep 2
curl -s 127.0.0.1:3040/api/salud; echo
```

`DP_TRAS_PROXY=1` le dice que el candado lo pone nginx, así que no fabrica su
sello. `DP_HOST=127.0.0.1` la deja invisible desde fuera hasta que queramos.

**Elige un puerto que no esté cogido.** En el VPS de CubaEmprende ya hay cosas
en 3006, 3007, 3030 y 3031; mira antes con `ss -lntp | grep node`.

**Crear el administrador AHORA, desde dentro.** Este bloque es una sola línea y
**pregunta el PIN al pegarlo**, para que no se quede escrito en la pantalla ni
en el historial:

```
read -s -p "PIN del administrador (solo numeros, 6 o mas): " P; echo && curl -s -X POST 127.0.0.1:3040/api/auth/crear-admin -H "Content-Type: application/json" -d "{\"nombre\":\"Administrador\",\"usuario\":\"admin\",\"pin\":\"$P\"}"; echo; unset P
```

La respuesta trae una **clave de recuperación**. Apúntala y guárdala: es lo
único que devuelve el acceso si se olvida el PIN.

---

## 4. El dominio y el candado (HTTPS de verdad)

**4.1 — nginx delante:**

```
cat > /etc/nginx/sites-available/dpadrones <<FIN
server {
    listen 80;
    listen [::]:80;
    server_name $DOM;

    # Las fotos de los productos y las salvas viajan enteras: 30M da margen
    # de sobra y evita el 413 que no dice nada útil.
    client_max_body_size 30M;

    location / {
        proxy_pass http://127.0.0.1:3040;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
FIN
ln -sf /etc/nginx/sites-available/dpadrones /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

Marcha atrás si algo falla:

```
rm /etc/nginx/sites-enabled/dpadrones
nginx -t && systemctl reload nginx
```

**4.2 — Comprobar que nginx llega al programa antes de pedir el certificado:**

```
curl -s -H "Host: $DOM" localhost/api/salud; echo
```

Tiene que contestar el JSON de salud. Si no, no sigas: certbot no arregla esto.

**4.3 — El certificado:**

```
certbot --nginx -d $DOM --agree-tos -m TU-CORREO --redirect --non-interactive
systemctl reload nginx
curl -s https://$DOM/api/salud; echo
```

Certbot reescribe el archivo de nginx y le añade el 443 y la redirección. Al
terminar, `https://$DOM` tiene que abrir con el candado bien.

**4.4 — Y ahora sí, abrirla al mundo.** Hasta aquí la aplicación solo escuchaba
en `127.0.0.1`; nginx ya llega, así que no hace falta cambiar nada más. Deja
`DP_HOST=127.0.0.1`: **al puerto 3040 solo se puede llegar por el proxy**, y
nadie puede saltárselo entrando por la IP.

---

## 5. La copia de seguridad (no te la saltes)

La aplicación ya se salva sola (DECISIONES.md #20), pero esas copias viven en el
**mismo disco**. Una copia que está en el disco que se rompe no es una copia.

```
mkdir -p /root/salvas-dpadrones
cat > /root/salvas-dpadrones/salvar.sh <<'FIN'
#!/bin/bash
# sqlite3 .backup copia EN CALIENTE y sin cortar nada; copiar el archivo a pelo
# mientras alguien cobra da una copia rota que parece buena hasta que hace falta.
D=/root/salvas-dpadrones
sqlite3 /root/dpadrones/dpadrones.db ".backup '$D/app-$(date +%Y%m%d-%H%M).db'"
# Quedarse con las 30 últimas y borrar las viejas
ls -1t $D/app-*.db | tail -n +31 | xargs -r rm --
FIN
chmod +x /root/salvas-dpadrones/salvar.sh
/root/salvas-dpadrones/salvar.sh
ls -lh /root/salvas-dpadrones/
```

Y una cada noche:

```
(crontab -l 2>/dev/null; echo "0 3 * * * /root/salvas-dpadrones/salvar.sh") | crontab -
crontab -l
```

**Bájate una copia de vez en cuando al PC.** Lo demás es teatro.

---

## Desplegar un cambio, de aquí en adelante

**Siempre en este orden.** El paso 1 existe porque ya pasó dos veces en otro
proyecto que el VPS tenía código editado a mano que nunca llegó a git y un `git
pull` se lo llevó por delante.

```
cd /root/dpadrones
git status
```

Si sale algo modificado que no esperabas, **para** y avisa. Se aparta sin perder
nada con `git stash push -u`.

Si está limpio, salvar antes de tocar:

```
/root/salvas-dpadrones/salvar.sh
ls -lh /root/salvas-dpadrones/ | tail -3
```

Y ahora sí, traer el código y reiniciar:

```
cd /root/dpadrones
git pull
npm install --omit=dev
pm2 flush dpadrones-app
pm2 restart dpadrones-app
sleep 3
pm2 logs dpadrones-app --lines 30 --nostream
```

**El `pm2 flush` va antes del reinicio, y no sobra.** `pm2 logs` hace `tail` de
un archivo que **no se vacía nunca**, así que los errores de días anteriores
—ya arreglados— siguen saliendo y parecen recién ocurridos. Sin vaciar, se
distinguen solo por el número de línea de la traza, que es el del código viejo.

### Comprobar que el despliegue ENTRÓ

`git log` dice lo que hay **en el disco**, no lo que se está ejecutando. Un
`git pull` sin `pm2 restart` deja el proceso corriendo el código viejo desde la
memoria, y **las migraciones no corren**, porque van en `initDB()`, o sea al
arrancar.

Lo que manda es esto:

```
curl -s https://$DOM/api/salud; echo
```

El campo `front` es la versión que sirve el proceso, y tiene que coincidir con
el `CACHE` de `public/sw.js`. Si no coincide, el reinicio no entró.

Y si el cambio traía una migración, la forma segura de saber si corrió **no es
mirar los registros** —se borran, se llenan, se confunden— sino preguntárselo a
la base: buscar la huella que solo esa migración deja.

### Que el teléfono se entere

El navegador solo ofrece la versión nueva cuando **`public/sw.js` cambia**. Si
tocaste algo de `public/` y no subiste el `CACHE`, los teléfonos se quedan con
el código viejo y parece que el arreglo no entró (DECISIONES.md #7).

---

## Si algo va mal

| Lo que ves | Qué mirar |
|---|---|
| No abre | `pm2 list` — ¿está `dpadrones-app` en `online`? `pm2 logs dpadrones-app` |
| «502 Bad Gateway» | El programa está caído: `pm2 logs dpadrones-app --lines 50` |
| El teléfono no ofrece «instalar» | Tiene que ser **https** y con el candado bien |
| El candado sale roto | `certbot certificates` — mira si caducó |
| Sube una foto y da error de tamaño | Falta `client_max_body_size 30M;` en nginx (paso 4.1) |
| Se arregló algo y el teléfono sigue igual | No subiste `CACHE` en `public/sw.js` |
| El puerto ya está cogido | `ss -lntp \| grep node` y elige otro |

Registros en vivo, para mirar mientras alguien prueba desde su teléfono:

```
pm2 logs dpadrones-app
```

Se sale con Ctrl+C.

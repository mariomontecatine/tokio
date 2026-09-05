<div align="center">

# tokio

**Deja el prompt para luego. Vigila tu cuota. Deja de vigilar el reloj del reset.**

Te quedaste sin tokens con una cosa pequeña sin probar. Apúntala aquí y vete —
`tokio` la ejecuta en cuanto tu ventana se reinicia.

[![Licencia: GPL v3](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.5-5FA04E.svg)](https://nodejs.org)
[![Estado](https://img.shields.io/badge/estado-alpha-f0b429.svg)](#hoja-de-ruta)

[English](README.md)

</div>

---

## El problema

A los agentes de código por suscripción no se les acaba el dinero, se les acaba la *ventana*.
Llegas al límite a las seis con un test sin correr, un rename a medias y un "¿esto compila?" sin
responder. El trabajo dura cinco minutos. La espera, tres horas. Así que o te quedas ahí
actualizando, o vuelves mañana sin acordarte de qué estabas haciendo.

Y mientras tanto nada te dice qué te queda en términos con los que puedas decidir. Un porcentaje
no es un plan. La pregunta de verdad es "¿me da para una refactorización más antes de cenar?", y
eso no lo responde nadie.

`tokio` hace las dos cosas:

- **Una cola que se dispara al resetear.** Deja prompts apuntados. Se ejecutan en tu máquina, en
  tu repo, en cuanto vuelve la cuota — retomando la sesión exacta en la que estabas, si quieres.
  Un prompt que todavía no se ha ejecutado sigue siendo un borrador: ábrelo en el panel y
  reescríbelo, y lo que pegaste dentro se queda plegado en vez de volver a llenarte la caja.
- **Un medidor con los números reales.** No una reconstrucción: `tokio` le pregunta a `/usage` del
  propio Claude Code por el porcentaje y la hora de reset de verdad, y añade lo que solo él puede
  calcular — tu ritmo de quemado y lo que va a costar una petición antes de lanzarla.
- **La cuenta de lo que vale el plan.** Todas las respuestas que has tenido, a precio de lista de
  la API, contra lo que pagas de verdad. A casi todo el mundo le sorprende.

## Empezar

```bash
curl -fsSL https://raw.githubusercontent.com/mariomontecatine/tokio/main/install.sh | sh
```

Eso comprueba tu Node, se descarga tokio en `~/.tokio`, lo compila y deja el
comando `tokio` en `~/.local/bin`. A partir de ahí, desde cualquier carpeta:

```bash
tokio                 # abre el panel, arrancando el daemon si no lo estaba
tokio status          # solo los números, sin necesidad de daemon
```

Escribir `tokio` en cualquier sitio arranca el daemon si no está en marcha y
abre el panel en tu navegador; si lo vuelves a ejecutar más tarde va directo a
la página que ya se está sirviendo, en vez de fallar por el puerto ocupado.
Añade `--no-open` para el daemon sin navegador, y usa `tokio start` en una
unidad de servicio: esa forma nunca abre nada.

Para actualizar, vuelve a ejecutar la misma línea: se actualiza y recompila en
el sitio. Para desinstalar: `rm -rf ~/.tokio ~/.local/bin/tokio`.

<details>
<summary>Desde el código, si lo prefieres</summary>

```bash
git clone https://github.com/mariomontecatine/tokio
cd tokio
npm install && npm run build
npm link
```
</details>

No hay nada que configurar ni cuenta que crear. `tokio` lee los transcripts que Claude Code ya
escribe en `~/.claude/projects/`, así que tu historial entero está ahí desde la primera ejecución.

Y cuando choques con el muro:

```bash
tokio add "corre los tests de integración y arregla lo que falle" --resume last
```

```
  resuming "Refactor del adaptador de pagos"

  Queued 79ed7209: corre los tests de integración y arregla lo que falle
  Estimate  $1.80 (up to $10.15)  — 167 past opus turns
  Leaves    ~87% of the 5h window
  Runs      when the window resets (11:00 PM)
  Safety    edits
```

Cierra el portátil.

## Lo que ves

<!-- Aquí va la captura. Mete dashboard.png en docs/screenshots/ y descomenta
     la línea de abajo. Ver docs/screenshots/README.md.

![El panel de tokio](docs/screenshots/dashboard.png)

-->

```
  Plan: Pro  (read from your Claude account)  (reported by Claude Code)

  5h window  █████░░░░░░░░░░░░░░░░░░░  21%   $1.15 of $5.40
             resets at 11:00 PM
  Week       ██░░░░░░░░░░░░░░░░░░░░░░   8%   $3.60 of $45.00

  Burning $2.10/h — the window resets before you run dry
  Worth 12.4× your subscription over the last 30 days

  Queue (2):
    972dab44  queued    ~$0.40  finish the parser tests
    79ed7209  queued    ~$0.15  tidy the changelog
```

El panel dibuja lo mismo como un solo gráfico: la ventana como una tira de registro, donde la
traza rellena es lo gastado, la línea punteada es dónde te deja tu ritmo actual, y los bloques
pasada la línea del reset son los trabajos esperando a la siguiente ventana.

<!-- Aquí va la captura: docs/screenshots/strip.png

![La tira de la ventana](docs/screenshots/strip.png)

-->

La tira se dibuja en porcentaje, a partir de las mismas lecturas que los anillos de arriba, así
que cubre toda la cuenta: una ventana gastada entera en la app de Claude o en otro portátil
también tiene altura aquí, muestreada cada pocos minutos en vez de turno a turno. Solo cuando no
hay ninguna lectura que dibujar vuelve a reconstruir la forma desde los transcripts de esta
máquina, y la fuente aparece en **Detalles**. La rentabilidad de abajo es lo contrario: solo
puede contar transcripts, así que es un suelo.

## ¿Te está saliendo a cuenta la suscripción?

```
$ tokio value

  Last 30 days

  Run on the API this would have cost       $248.10
  Subscription for those 30 days             $20.00  ($20.00/month)
  So the plan is paying back                  12.4×

  Today 18.2×   ·   Yesterday 7.5×   ·   7 days 11.0×
  Last 5 hours  $3.90
```

Cada respuesta que has recibido está en los transcripts, y cada una tiene un precio. Sumándolas
sale lo que te habría costado el mismo mes con una clave de API de pago por uso.

Dos matices honestos, que el propio comando imprime:

- Cuenta **los transcripts de esta máquina**. Lo que hicieras en otro portátil, o en la app de
  Claude, no está ahí: el número es un suelo, no un total.
- Es **precio de lista de la API**, es decir, lo que habrías pagado *tú*. No es lo que le cuesta
  a Anthropic servirte; su coste de inferencia es suyo y bastante menor.

### De dónde salen los precios

No nos los inventamos. Claude Code lleva dentro un catálogo de modelos mantenido a mano —el mismo
que hay detrás de su propio `/cost` y de las etiquetas por Mtok de `/model`— y
[`src/meter/catalog.ts`](src/meter/catalog.ts) lo replica: los mismos tramos, el mismo mapeo de
modelo a tramo, los mismos recargos. De ahí salen tres cosas, y son la diferencia entre un número
y una suposición:

- **Los precios son por modelo, no por familia.** Opus 4.1 va a `$15/$75` por Mtok; Opus 4.5 y
  todo lo posterior, a `$5/$25`. Sonnet 4.6 son `$3/$15` y Sonnet 5 `$2/$10`. Una tarifa por
  familia se equivoca en la mayoría de los transcripts por un múltiplo, no por un redondeo.
- **Los extras también cuentan.** El modo rápido es el mismo modelo a tarifa premium,
  `inference_geo: "us"` lleva un 10% de recargo, las escrituras de caché se reparten entre el
  tramo de 5 minutos y el de 1 hora, y las búsquedas web del servidor se cobran por petición. Las
  cuatro cosas están en el transcript, así que las cuatro se cuentan.
- **Corregir una tarifa recalcula tu historial.** Los créditos se guardan por evento, pero los
  recuentos de tokens de los que salieron no cambian nunca, así que corregir una tarifa recalcula
  todos los eventos que ya tenías en vez de dejar meses antiguos valorados con la tabla de aquella
  semana.

**Y se comprueba a sí mismo.** Claude Code escribe a veces una línea `cost-state` en el transcript
con el total que calculó *él* para esa sesión. Donde la haya dejado, `tokio value` compara ambos y
lo dice:

```
  Checked against Claude Code's own total on 2 session(s): $37.26 here vs $38.96 there (96%).
```

Quedarse un poco por debajo es lo esperado y es la respuesta honesta: unas pocas llamadas —el
Haiku que titula la sesión, la compactación, los reintentos— nunca aparecen en el transcript como
mensajes del asistente, así que no hay nada ahí que podamos contar. Ese hueco es el matiz del
"suelo" de arriba, pero medido en vez de afirmado.

**No hay ninguna cifra en dólares que pedirle a Anthropic.** Con suscripción, `claude -p "/cost"`
devuelve porcentajes y horas de reinicio y ningún coste —a propósito, porque un plan Pro o Max no
se factura por token—. Los informes de uso y coste de la Admin API cubren organizaciones con clave
de API, no suscripciones. Así que los tokens exactos vienen de Anthropic (el objeto `usage` de
cada línea del transcript), los precios vienen del catálogo de Claude Code, y la multiplicación es
lo único que ponemos nosotros.

Si te suscribiste antes de tu transcript más antiguo, díselo para que cuadren los meses:

```json
{ "subscriptionStartedAt": "2026-05-14", "planPriceUsd": 100 }
```

## Cómo funciona

```
  ~/.claude/projects/**/*.jsonl          Claude Code ya los escribe
              │
              ▼
     ┌─────────────────┐
     │  ingesta        │  lee cada transcript, deduplica las copias del
     │                 │  streaming y agrupa las llamadas por turno
     └────────┬────────┘
              ▼
     ┌─────────────────┐    ┌──────────────────┐
     │  medidor        │◄───│  claude -p       │  el porcentaje y el reset
     │  5 h + semanal  │    │  "/usage"        │  reales, gratis de sondear
     └────────┬────────┘    └──────────────────┘
              │
              ▼
     ┌─────────────────┐    ┌──────────────────┐
     │  planificador   │───►│  claude -p       │  en tu repo, en tu máquina,
     │  reserva mínima │    │  --resume …      │  con tu entorno levantado
     └────────┬────────┘    └────────┬─────────┘
              │                      │
              ▼                      ▼
        panel + CLI            el coste real alimenta
                               la siguiente estimación
```

Tres detalles hacen que los números signifiquen algo:

**Deduplicación.** Claude Code escribe la misma respuesta más de una vez en el transcript
mientras va llegando: en los transcripts de mi máquina hay 1,93 líneas por cada respuesta real, y
algunas aparecen tres veces. Contar líneas casi duplica el consumo aparente. `tokio` usa
`messageId` + `requestId`, así que cada respuesta cuenta una vez.

**El coste como unidad.** Los tokens no son comparables entre modelos: un turno de Opus vacía el
plan unas cinco veces más rápido que uno de Sonnet, y una lectura de caché es una décima parte de
un token de entrada. Todo se convierte a una unidad equivalente en dólares con el precio público
de la API, que es a lo que escalan de verdad los límites de la suscripción.

**Historial por turno.** Las llamadas se agrupan por el prompt que las provocó, así que la
estimación responde a "cuánto cuesta una petición como esta" y no a "cuánto cuesta una sesión
entera". Funciona desde el primer arranque, porque tus transcripts ya son los datos.

## Sobre esos límites

Anthropic no publica el tamaño de la ventana de cada plan, así que **los topes que vienen en
[`src/plans/profiles.json`](src/plans/profiles.json) son estimaciones**. `tokio` lo dice en todos
los sitios donde enseña uno, y nunca disfraza una suposición de medición.

En la práctica casi nunca se usan: en cuanto `/usage` devuelve un porcentaje real —lo que ocurre
de inmediato si has iniciado sesión con una suscripción— el tope se deduce de ahí y las
estimaciones dejan de pintarse. Solo importan a quien usa una clave de API, que no recibe ningún
porcentaje.

Arreglarlo cuesta diez segundos. Ejecuta `/usage` dentro de Claude Code, mira el porcentaje y
díselo:

```bash
tokio calibrate 63
```

```
  Counted $78.75 in this block window, which you say is 63%.
  So your block cap is about $125.00. Saved.
```

La ventana semanal se calibra aparte:

```bash
tokio calibrate 15 --window week
```

Con una lectura por ventana basta; con varias aguanta mejor el redondeo de ese porcentaje. Además, cualquier
límite con el que `tokio` choque de verdad queda registrado como cota inferior y sube la
estimación. La cabecera te dice en todo momento cuál de las dos cosas estás viendo.

### Qué plan tienes

Se lee de tu cuenta de Claude: ni se pregunta ni se supone. Claude Code guarda en `.claude.json`
el perfil que le devuelve Anthropic, y el plan está ahí — `organizationType` dice Pro o Max, y
`organizationRateLimitTier` es lo que separa Max 5× de Max 20×. Son los dos mismos campos que usa
el propio Claude Code para distinguirlos.

Importa porque el precio del plan es el divisor de toda la rentabilidad: leer una cuenta Pro como
Max 5× dividiría por cinco lo que en realidad te está devolviendo la suscripción.

Tres reglas lo mantienen honesto:

- **Un plan que pongas a mano no lo pisa nunca la detección.** El `plan` de tu configuración manda.
- **Team, Enterprise y un Max sin precisar se dejan como desconocidos**, porque los dos planes Max
  se diferencian a la mitad en precio y en límites, y adivinar pondría un precio equivocado debajo
  de todo lo demás.
- **Un plan desconocido no produce ninguna rentabilidad**, en vez de una plausible. Los medidores
  siguen funcionando: salen de los porcentajes de Anthropic y nunca necesitaron el plan.

No sale nada a ninguna parte: es la lectura de un fichero que ya tienes, y no se toma nada de él
salvo el plan.

### Dónde funciona

| | Daemon y CLI | Instalación de una línea | Te abre el navegador | Notificaciones de escritorio |
|---|---|---|---|---|
| Linux | sí | sí | `xdg-open` | `notify-send` |
| macOS | sí | sí | `open` | `osascript` |
| WSL | sí | sí | `wslview`, si no `explorer.exe` | aviso de Windows |
| Windows | sí | usa los pasos desde el código | `start` | aviso de Windows |

Lo que no pueda hacer, lo dice e imprime la URL en vez de fallar.

## Seguridad

Los trabajos en cola se ejecutan sin ti delante. Esa es la gracia y también el riesgo, así que la
correa la eliges tú en cada trabajo:

| Modo | Opción | Qué puede hacer |
|---|---|---|
| `plan` | `--safety plan` | Lee y propone. No toca nada. |
| `edits` | `--safety edits` | Edita ficheros y ejecuta herramientas sin preguntar. **Por defecto.** |
| `full` | `--safety full` | Sin restricciones, dentro de ese directorio. |

Dos costumbres que compensan: encola el trabajo desatendido sobre una rama que no te importe
rebobinar, y reserva `plan` para lo que no tengas pensado del todo. `tokio` nunca amplía los
permisos de un trabajo por su cuenta, y un trabajo solo toca el directorio que le diste.

### Privacidad, y qué sale de tu máquina

No sale nada que no hayas configurado tú. Conviene saberlo antes de usarlo, y antes de publicar un
fork:

- **`tokio` no lee, ni guarda, ni reenvía tus credenciales de Claude.** No toca
  `~/.claude/.credentials.json` ni ninguna clave de API. Lanza `claude` como subproceso y deja que
  Claude Code se autentique solo, igual que cuando lo ejecutas a mano.
- **La base de datos y la configuración se quedan en tu máquina**, en `~/.local/share/tokio/` y
  `~/.config/tokio/` —fuera del repositorio, así que un `git add .` no puede arrastrarlas—. La
  configuración se escribe solo para el propietario (`0600`) porque puede contener un token de
  acceso y un token de bot de Telegram.
- **El panel escucha en `127.0.0.1` por defecto.** Si lo abres a otra dirección, el daemon genera
  un token de acceso aleatorio e imprime una URL que lo lleva; sin ese token la API responde 401.
  El token viaja en una cabecera en todas partes salvo en `/api/stream`, que no puede enviarla.
- **`tokio config` y `GET /api/config` enmascaran los secretos.** Puedes pegar la salida en un
  informe de fallo sin releerla. Los valores reales están en el fichero, que el comando te nombra.
- **Las notificaciones son lo único que sale.** Un tema de ntfy, un chat de Telegram o un webhook
  reciben solo lo que hayas configurado, y los tres están apagados hasta que los enciendes. El
  nombre de un tema de ntfy *es* la contraseña de ese tema —quien lo sepa puede leer tus
  notificaciones—, así que ponlo imposible de adivinar.

Lo que hay que tener claro es que **la API puede ejecutar código como tú**. Encolar un trabajo
significa ejecutar `claude` en un directorio que tú indicas, y `--safety full` significa
ejecutarlo sin restricciones. En loopback eso es tu propia shell. Si expones el panel a una red, el
token es lo único que separa a alguien de esa red de una shell en tu máquina: trátalo como una
clave SSH y no pongas el daemon en una red en la que no confíes.

El planificador guarda además una **reserva** (10% por defecto). Un trabajo no arranca si su
estimación pesimista se comería ese suelo, para que una cola desatendida no te vacíe en silencio
la ventana que estabas guardando. Con `--urgent` se salta la regla.

## Órdenes

| Orden | Qué hace |
|---|---|
| `tokio` | Abre el panel, arrancando el daemon si hace falta (`--no-open` para no abrir navegador) |
| `tokio status` | Cuota, ritmo de quemado, agotamiento previsto y cola |
| `tokio refresh` | Vuelve a leer los números reales de Claude Code y los muestra |
| `tokio value` | Lo que ha valido la suscripción, mes a mes |
| `tokio start` | Daemon, planificador y panel, sin abrir navegador |
| `tokio open` | Abre el panel de un daemon que ya esté en marcha |
| `tokio add <prompt>` | Encola un prompt |
| `tokio ls [--all]` | Lista los trabajos |
| `tokio show <id>` | Un trabajo y su salida |
| `tokio run <id>` | Ejecuta uno ya, en primer plano |
| `tokio rm <id>` | Quita un trabajo |
| `tokio calibrate <pct>` | Le enseña tu límite real |
| `tokio sessions` | Sesiones que puedes retomar en este directorio |
| `tokio config` | Muestra el fichero de configuración, con los secretos enmascarados |

Opciones de `add`:

| Opción | Por defecto | |
|---|---|---|
| `--cwd <dir>` | directorio actual | En qué proyecto se ejecuta |
| `--resume <id\|last>` | sesión nueva | Continúa una conversación existente |
| `--model <nombre>` | el de tu Claude Code | `opus`, `sonnet`, `haiku` o un id completo |
| `--safety <modo>` | `edits` | Ver la tabla de arriba |
| `--when <política>` | `on-reset` | `on-reset`, `asap`, `manual` o una hora ISO |
| `--urgent` | apagado | Permite gastar de la reserva |

## Configuración

`~/.config/tokio/config.json`, se crea solo. Las que importan:

| Clave | Por defecto | |
|---|---|---|
| `plan` | `auto` | Se lee de tu cuenta de Claude. Puedes forzar `pro`, `max5`, `max20` o `custom` |
| `subscriptionStartedAt` | `null` | `"2026-05-14"` — desde cuándo pagas, para `tokio value` |
| `planPriceUsd` | `null` | Cambia el precio mensual (precio regional, asiento de equipo) |
| `reservePct` | `10` | Cuánto de la ventana te guardas |
| `usagePollMs` | `180000` | Cada cuánto releer los porcentajes reales |
| `usageMaxAgeMs` | `900000` | A partir de aquí la lectura caduca y se vuelve a estimar; también caduca en cuanto llega el reset que ella misma anunciaba |
| `defaultSafety` | `edits` | Correa de los trabajos nuevos |
| `weeklyAnchor` | `null` | `{ "weekday": 3, "hour": 11 }` — al ponerlo, el medidor semanal muestra un reset real en vez de una ventana rodante |
| `concurrency` | `1` | Trabajos a la vez |
| `notify` | — | Tema de ntfy, bot de Telegram, webhook, escritorio |
| `host` / `port` | `127.0.0.1:4646` | Fuera de loopback se genera un `token` si no tienes |
| `token` | `null` | Necesario para acceso no local; va en cabecera o como `?token=` |

### Mantenerlo en marcha

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/tokio.service <<EOF
[Unit]
Description=tokio

[Service]
# Rutas absolutas a propósito: una unidad de usuario no hereda el PATH de tu
# shell, así que un node gestionado por versión (nvm, fnm, volta) no existe
# para ella.
ExecStart=$(command -v node) $(pwd)/dist/cli.js start
WorkingDirectory=$(pwd)
Restart=on-failure

[Install]
WantedBy=default.target
EOF
systemctl --user enable --now tokio
systemctl --user status tokio --no-pager
```

Ejecútalo desde el repo, para que `$(pwd)` resuelva. Para que sobreviva al
cierre de sesión, `loginctl enable-linger $USER`.

## Preguntas

**¿Funciona con ChatGPT?**
Con la suscripción ChatGPT Plus/Pro no: no tiene API, y manejar la web con un robot de navegador
incumpliría los términos de OpenAI y se rompería con cada rediseño. `tokio` no va a hacer eso.
Las claves de API de pago y el propio Codex CLI de OpenAI son otra cosa y están en la hoja de ruta.

**¿Esto va contra los términos de Anthropic?**
No. `tokio` lee ficheros de log de tu propio disco y ejecuta el CLI oficial igual que lo harías
tú, a ritmo normal. No comparte cuentas, no esquiva límites ni oculta tráfico: cuando el límite
dice basta, los trabajos esperan. Es un planificador, no un truco.

**Ya veo mis sesiones en la app de Claude. ¿Para qué quiero esto?**
La app retoma muy bien una conversación desde el móvil, pero solo mientras te quede cuota. No
guarda un prompt hasta que resetee tu límite, no te dice lo que va a costar una petición, y una
sesión en la nube no es tu máquina, con tu base de datos levantada y tus servicios corriendo.
Ese es el hueco que cubre esto.

**¿Cómo de buenos son los números?**
Los porcentajes y las horas de reset son los de Anthropic, así que son exactos a fecha de la
última lectura — el panel enseña su antigüedad y la refresca cuando quieras. Las *previsiones de
coste* sí son rangos, no promesas. El panel te enseña con qué frecuencia la realidad cayó dentro del rango
que predijo, para que lo juzgues tú. En la práctica se ajusta rápido, porque cada trabajo
terminado alimenta la siguiente estimación.

**¿El número de rentabilidad es lo que le cuesto a Anthropic?**
No, y leerlo así sería un error. Es lo que habrías pagado *tú* a precio de lista de la API por el
mismo trabajo: la alternativa que no compraste. Lo que le cuesta a Anthropic servirte es menor y
no es público.

**¿Dónde están mis datos?**
En `~/.local/share/tokio/tokio.db`, en tu máquina. No se envía nada a ninguna parte. El panel
escucha solo en loopback salvo que lo cambies a propósito.

## Hoja de ruta

- [x] Medidor con ventanas de 5 h y semanal
- [x] Cola que se dispara al resetear, con reserva protegida
- [x] Estimación de coste con bucle de realimentación
- [x] Porcentajes y resets reales leídos del propio `/usage` de Claude Code
- [ ] Proveedores de pago por token (API de Anthropic, compatibles con OpenAI, Ollama) por la
      interfaz [`Provider`](src/providers/types.ts) que ya existe
- [ ] Codex CLI de OpenAI, para quien tenga la suscripción de ese lado
- [ ] Trabajos encadenados — "si este pasa, lanza el siguiente"
- [ ] **Suspender cuando la cola se vacíe.** Dejas trabajo encolado de noche y el equipo duerme en
      vez de estar encendido sin hacer nada. La restricción es todo el diseño: solo puede
      dispararse con la cola *completamente* vacía —nada corriendo, encolado, diferido ni
      programado—, porque dormir tras el primero de tres trabajos deja los otros dos sin
      ejecutarse, que es justo lo contrario de encolarlos. Apagado por defecto, con cuenta atrás
      cancelable, y nunca con un trabajo escribiendo. La versión que merece la pena lo combina con
      un despertador RTC a la hora del reset: duerme, se despierta cuando se abre la ventana, vacía
      la cola y se vuelve a dormir; eso pide root en casi todos los sistemas.

## Desarrollo

```bash
npm test          # 108 tests, sin gastar tokens: el ejecutor corre contra un CLI falso
npm run dev       # daemon desde el código, sin compilar
npm run dev:web   # panel con recarga en caliente
```

Node ≥ 22.5 (por `node:sqlite` integrado). El servidor se ejecuta con el borrado de tipos de
Node, así que evita TypeScript que necesite generar código: nada de enums, propiedades de
parámetro ni decoradores.

Se agradecen contribuciones, sobre todo adaptadores de proveedores y datos reales de calibración.

## Licencia

GPL-3.0-or-later. Ver [LICENSE](LICENSE).

---

<sub>Sin relación con Anthropic ni OpenAI. Los límites de plan son estimaciones hasta que los
calibres. El nombre es un juego con token e I/O; el runtime de Rust llegó antes y no tiene nada
que ver.</sub>

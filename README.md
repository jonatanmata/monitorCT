# MonitorCt — Monitoreo de Red WISP con Diagnóstico IA

Sistema de monitoreo para redes inalámbricas de campo (WISP) con equipos **MikroTik**, **PTP Mimosa** y **Ubiquiti airMAX**. Corre en un PC Windows dentro de la red y ofrece:

- 🗺️ **Constructor visual de topología**: parte del nodo base 💻 **Monitor (PC)** — la raíz de la red — y ve conectando equipos hacia afuera según el camino de la señal. Puedes **"romper el hilo"** de cualquier conexión con el botón **+** para insertar equipos intermedios (un PTP inserta sus 2 antenas automáticamente).
- 📊 **Monitoreo automático**: ping cada 15 s a todos los equipos; cada 60 s lee CPU/memoria/tráfico/drops de los MikroTik (API RouterOS) y señal/ruido/CCQ/SNR/capacidad de las antenas (SNMP).
- 🌐 **Sondas hacia internet**: mide pérdida a 8.8.8.8 y al gateway público **desde el PC** y **desde cada MikroTik** (incluso con `src-address` LAN para simular tráfico de cliente — el ping normal del router no pasa por las colas y esconde la saturación).
- 🔥 **Detección de saturación**: % de utilización por enlace, drops de cola, matriz de pérdida por origen→destino y mapa de calor por hora del día para confirmar problemas de horas pico.
- 🚨 **Alertas** por umbrales (CPU, señal, pérdida, nodo caído, saturación+pérdida).
- 🤖 **Diagnóstico con IA (Claude)**: un chat donde la IA investiga tu red con herramientas reales (métricas, pings en vivo, matriz de pérdida) y te dice el punto de falla más probable. Las alertas nuevas reciben diagnóstico automático.
- ✈️ **Alertas por Telegram**: recibe las alertas y sus diagnósticos de IA directamente en tu Telegram (configurable desde la interfaz, sin tocar archivos).
- 🔌 **Diagnóstico de cable UTP (capa física)**: en MikroTik, prueba **TDR** bajo demanda que dice par por par si el cable está OK/abierto/en corto y **a qué distancia** está la falla. Además vigila de forma continua la **velocidad negociada**, el **dúplex** y los **errores CRC/FCS** de cada puerto, y alerta cuando algo apunta a cable/conector/EMI (ej. un Gigabit que baja a 100 Mbps). La IA lo usa para descartar problemas físicos antes de culpar RF o saturación.

## Requisitos

- **Node.js 20 o 22 LTS** — <https://nodejs.org> (instalador Windows .msi)
- Acceso de red desde el PC a todos los equipos a monitorear
- **SNMP habilitado** en antenas Ubiquiti (Services → SNMP) y Mimosa (Preferences → Management)
- **API habilitada** en los MikroTik (IP → Services → api, puerto 8728) y un usuario con permisos de lectura + test
- (Opcional, para la IA) una API key de Anthropic: <https://console.anthropic.com>

## Instalación en Windows

```bat
git clone https://github.com/jonatanmata/monitorCT.git MonitorCt   (o copiar la carpeta)
cd MonitorCt
npm install
copy .env.example .env
notepad .env                      (opcional: poner un SECRET_KEY aleatorio)
npm run build
npm start
```

Abrir **http://localhost:3000** en el navegador.

> 💡 **La API key de la IA se configura desde la propia interfaz** (pestaña **⚙ Ajustes**): se valida contra Anthropic y se guarda **cifrada** en la base local — no hace falta editar el `.env`. La variable `ANTHROPIC_API_KEY` del `.env` sigue funcionando y tiene prioridad si existe.
>
> Cada módulo de la interfaz tiene un icono **!** naranja con la explicación de qué hace y cómo interpretarlo.

### Ejecutar como servicio de Windows (opcional)

Con [NSSM](https://nssm.cc/): `nssm install MonitorCt "C:\Program Files\nodejs\node.exe" "C:\ruta\MonitorCt\server\dist\index.js"` (con `AppDirectory` = carpeta del proyecto). Así arranca solo con el PC.

## Primeros pasos

1. **Dibuja la topología**: usa la paleta (izquierda) para añadir cada equipo. Conecta los nodos arrastrando del borde derecho de uno al izquierdo del siguiente, siguiendo el camino de la señal (ej. `Gateway Azteca → MikroTik Pandi → PTP Pandi-Icononzo → MikroTik Icononzo → …`).
2. **Configura cada nodo** (clic sobre él): IP, credenciales API (MikroTik) o community SNMP (antenas). Usa **Probar conexión** para validar.
3. **Configura cada enlace** (clic sobre la línea): capacidad real en Mbps y la interfaz del equipo origen que lo transporta (ej. `ether2`, `wlan1`). Esto habilita el % de utilización.
4. **Sondas externas**: en cada MikroTik agrega targets (ej. `8.8.8.8`, la IP del gateway público del dedicado) y una IP LAN del router como "IP origen" — así el ping viaja como tráfico de cliente.
5. Deja correr el sistema unos días y revisa la pestaña **Saturación**: la matriz de pérdida y el mapa de calor por horas muestran dónde y cuándo se pierde el tráfico.
6. Pregunta en la pestaña **🤖 IA**: «¿por qué los clientes pierden paquetes hacia 8.8.8.8 si la red local está bien?»

## Desarrollo

```bash
npm run dev    # server en :3000 (tsx watch) + web en :5173 (vite, con proxy)
npm test       # pruebas unitarias del servidor
```

## Estructura

- `server/` — Fastify + WebSocket, pollers (ping/RouterOS/SNMP), motor de alertas, agente IA (Claude API con tool use), SQLite en `data/monitorct.sqlite`.
- `web/` — React + Vite, lienzo React Flow, gráficas Recharts, chat con streaming.

Las credenciales de los equipos se guardan **cifradas (AES-256-GCM)** en la base local y nunca salen del PC salvo hacia los propios equipos. Retención de datos: crudos 48 h, agregados de 5 min por 30 días.

## Notas sobre OIDs SNMP

Los OIDs de Ubiquiti (airMAX, enterprise 41112) y Mimosa (enterprise 43356) están en `server/src/snmp/oids.ts`. Se consultan por walk de subárbol, tolerante a variaciones de firmware. Si algún equipo no reporta una métrica, usa "Probar conexión" para confirmar que SNMP responde y revisa la versión del firmware.

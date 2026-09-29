/* =====================================================================
   Retrato con poema.

   Subes tu foto, escribes un poema, y el poema se acomoda encima de
   tu silueta, siguiendo la forma de tu cuerpo. Puedes elegir si el
   texto va en blanco o negro, y guardar el resultado como imagen.

   Todo (panel lateral, botones, textos) se crea desde este archivo,
   así que solo necesitas index.html + sketch.js.
   ===================================================================== */

// ---------------------------------------------------------------------
// AJUSTES
// ---------------------------------------------------------------------
const CONFIG = {
  maxCanvasSize: 2000,         // tamaño máximo de lado (evita que fotos enormes de celular colapsen el navegador)

  maskFeather: 2,              // suaviza el borde de la silueta detectada
  cellCoverageThreshold: 140,  // qué tan "segura" debe estar la detección

  lineSpacing: 24,             // separación entre líneas del poema (a tamaño de referencia)
  minSegmentWidth: 40,         // ancho mínimo de cuerpo para escribir ahí (a tamaño de referencia)
  maxRowGap: 16,               // huecos pequeños que se ignoran (a tamaño de referencia)
  referenceSize: 900,          // tamaño de foto para el que estos valores están pensados;
                                // con fotos más grandes o chicas, todo escala proporcionalmente

  showGrid: false,             // true = muestra líneas guía (para probar)
  gridLineColor: [255, 255, 255],
  gridLineAlpha: 55,

  fontFamily: "Courier New, monospace",
  fontSize: 13,
  textColor: [255, 255, 255],   // color del poema (blanco por defecto)
  textAlpha: 235,
  textOutline: true,            // sombra detrás del texto, para que se lea bien

  // Modelo de detección de personas: MobileNetV1 es liviano y rápido;
  // ResNet50 sería más preciso pero mucho más pesado.
  bodyPixOptions: {
    architecture: "MobileNetV1",
    outputStride: 16,
    multiplier: 0.75,
    segmentationThreshold: 0.6
  }
};

// ---------------------------------------------------------------------
// ESTADO GENERAL
// ---------------------------------------------------------------------
let bodyPixModel;
let originalImg;
let maskImg;
let gridLayer;

let modelReady = false;
let photoReady = false;
let maskReady = false;  // ya se detectó a la persona en la foto actual
let photoId = 0;        // cambia con cada foto, para ignorar detecciones viejas
let renderId = 0;       // cambia con cada dibujo del poema, para ignorar dibujos viejos
let renderTimer = null; // espera a que dejes de escribir antes de redibujar
let appState = "vacio"; // vacio -> procesando -> listo

// Elementos de la interfaz
let uploadBtn, fileInputEl, poemTextarea, statusDiv, cnv, canvasFrameEl;
let textColorWhiteBtn, textColorBlackBtn, saveBtnEl, previewCanvasEl;

// ---------------------------------------------------------------------
// Ejecuta un trabajo pesado en partes pequeñas, para que la página no
// se congele mientras procesa.
// ---------------------------------------------------------------------
function runChunked(totalIterations, chunkSize, workFn, onDone) {
  let i = 0;
  function step() {
    const end = Math.min(i + chunkSize, totalIterations);
    for (; i < end; i++) {
      workFn(i);
    }
    if (i < totalIterations) {
      setTimeout(step, 0);
    } else {
      onDone();
    }
  }
  step();
}

// Da el mismo tamaño a la vista previa y al recuadro del resultado:
// todo el ancho del panel, con forma de postal (POSTCARD_RATIO). Si así
// el panel no cabe en la pantalla, los achica lo justo para que quepa.
// Achica el canvas en pantalla para que la foto quepa adentro sin
// deformarse; el tamaño real de la imagen no cambia.
function layoutBoxes() {
  const stageEl = document.getElementById("stage");
  const slotEl = document.getElementById("previewSlot");
  const panelEl = document.getElementById("panel");
  if (!stageEl || !slotEl || !panelEl) return;

  const innerWidth = (el) => {
    const st = getComputedStyle(el);
    return el.clientWidth - parseFloat(st.paddingLeft) - parseFloat(st.paddingRight);
  };
  let boxW = Math.max(0, Math.floor(Math.min(innerWidth(stageEl), innerWidth(slotEl))));
  applyBoxSize(boxW, boxW / POSTCARD_RATIO);

  // Lo que sobra de alto se reparte entre los dos recuadros
  const overflow = panelEl.scrollHeight - panelEl.clientHeight;
  if (overflow > 0) {
    const boxH = Math.max(60, boxW / POSTCARD_RATIO - overflow / 2);
    applyBoxSize(Math.floor(boxH * POSTCARD_RATIO), Math.floor(boxH));
  }
}

function applyBoxSize(boxW, boxH) {
  for (const el of [canvasFrameEl.elt, document.getElementById("previewBox")]) {
    el.style.width = boxW + "px";
    el.style.height = boxH + "px";
  }

  // El canvas del resultado cabe dentro del recuadro (menos su borde interno)
  const frameStyle = getComputedStyle(canvasFrameEl.elt);
  const innerW = boxW - parseFloat(frameStyle.paddingLeft) - parseFloat(frameStyle.paddingRight);
  const innerH = boxH - parseFloat(frameStyle.paddingTop) - parseFloat(frameStyle.paddingBottom);
  const scale = Math.min(1, innerW / width, innerH / height);
  cnv.elt.style.width = Math.floor(width * scale) + "px";
  cnv.elt.style.height = Math.floor(height * scale) + "px";
}

function windowResized() {
  layoutBoxes();
  drawPreview();
  buildPostcards();
}

// ---------------------------------------------------------------------
// POSTALES (lado derecho)
// Recorren tres filas en zigzag: entran abajo a la derecha y van hacia
// la izquierda; al salir, aparecen en la fila del medio y van de
// izquierda a derecha; al salir, pasan a la fila de arriba y van de
// derecha a izquierda. Al salir de arriba vuelven a entrar abajo.
// Por ahora son cuadrados de muestra; en el futuro serán las obras.
// ---------------------------------------------------------------------
const POSTCARD_GAP = 24;   // espacio entre postales y entre filas (px)
const POSTCARD_SPEED = 40; // velocidad (px por segundo)
const POSTCARD_RATIO = 3 / 2; // ancho / alto, como una foto normal (10x15 cm)
const POSTCARD_TEST_COLORS = true; // prueba: cada postal con color y número propio, para seguir su recorrido

let postcardEls = [];
let postcardLayout = null;
let postcardProgress = 0;  // cuánto ha avanzado la fila completa
let postcardLastTime = null;
let postcardsPaused = false;     // el mouse está encima
let postcardViewerOpen = false;  // hay una postal abierta en grande
let postcardViewerEl, postcardLargeEl, postcardFrontEl, postcardBackEls;

// Crea tantas postales como caben a lo largo del recorrido completo
function buildPostcards() {
  const below = document.getElementById("below");
  if (!below) return;
  postcardEls.forEach((el) => el.remove());

  const W = below.clientWidth;
  const H = below.clientHeight;
  const cardH = Math.max(40, (H - POSTCARD_GAP * 4) / 3); // tres filas + espacios
  const cardW = cardH * POSTCARD_RATIO;
  const rowLength = W + cardW;      // de totalmente afuera a un lado, a totalmente afuera al otro
  const pathLength = rowLength * 3; // las tres filas seguidas
  const count = Math.max(1, Math.floor(pathLength / (cardW + POSTCARD_GAP)));

  postcardLayout = { W, cardW, cardH, rowLength, pathLength, spacing: pathLength / count };
  postcardEls = [];
  for (let i = 0; i < count; i++) {
    const el = document.createElement("div");
    el.className = "postcard";
    el.style.width = cardW + "px";
    el.style.height = cardH + "px";
    if (POSTCARD_TEST_COLORS) {
      // Solo colores fríos: del verde agua (170) al violeta (270)
      el.style.background = `hsl(${Math.round(170 + (i * 100) / count)}, 50%, 72%)`;
      el.textContent = i + 1;
    }
    // Datos del reverso. Por ahora son de muestra; en el futuro vendrán
    // de lo que cada persona escriba al compartir su obra.
    el.postcardData = {
      number: i + 1,
      name: `Persona ${i + 1}`,
      place: "Ciudad, país",
      date: "Fecha de envío",
      poem: "Aquí irá un fragmento del poema que esta persona plasmó en su autorretrato."
    };
    el.addEventListener("click", () => openPostcard(el));
    below.insertBefore(el, postcardViewerEl); // debajo del visor
    postcardEls.push(el);
  }
  placePostcards();
  if (postcardViewerOpen) sizeLargePostcard();
}

// Muestra una postal en grande, centrada en el lado derecho, y detiene
// todas las demás mientras está abierta. Siempre abre por el frente.
function openPostcard(el) {
  postcardViewerOpen = true;
  const data = el.postcardData;

  postcardFrontEl.style.background = getComputedStyle(el).backgroundColor;
  postcardFrontEl.textContent = el.textContent;

  // Se usa textContent (no innerHTML) porque en el futuro estos datos
  // los escribirán otras personas
  postcardBackEls.poem.textContent = data.poem;
  postcardBackEls.name.textContent = data.name;
  postcardBackEls.place.textContent = data.place;
  postcardBackEls.date.textContent = data.date;
  postcardBackEls.stamp.textContent = "N.º " + data.number;

  postcardLargeEl.classList.remove("flipped");
  sizeLargePostcard();
  postcardViewerEl.classList.add("open");
}

function closePostcard() {
  postcardViewerOpen = false;
  postcardsPaused = false; // siguen de inmediato, aunque el mouse siga encima
  postcardViewerEl.classList.remove("open");
}

// La postal abierta ocupa lo más posible del lado derecho (con margen),
// sin deformarse. --h sirve para que las letras del reverso escalen.
function sizeLargePostcard() {
  const below = document.getElementById("below");
  const maxW = below.clientWidth * 0.65;
  const maxH = below.clientHeight * 0.65;
  const w = Math.min(maxW, maxH * POSTCARD_RATIO);
  const h = w / POSTCARD_RATIO;
  postcardLargeEl.style.width = w + "px";
  postcardLargeEl.style.height = h + "px";
  postcardLargeEl.style.setProperty("--h", h + "px");
}

// Arma el reverso de la postal: a la izquierda el mensaje (poema), a la
// derecha el sello y los datos de quién la envía
function buildPostcardBack(backEl) {
  const make = (cls, parent, text) => {
    const el = document.createElement("div");
    el.className = cls;
    if (text) el.textContent = text;
    parent.appendChild(el);
    return el;
  };

  const message = make("pc-message", backEl);
  make("pc-label", message, "Poema");
  const poem = make("pc-poem", message);

  make("pc-divider", backEl);

  const address = make("pc-address", backEl);
  const stamp = make("pc-stamp", address);
  const field = (label) => {
    const line = make("pc-line", address);
    make("pc-label", line, label);
    return make("pc-value", line);
  };
  const name = field("De");
  const place = field("Desde");
  const date = field("Fecha");

  return { poem, name, place, date, stamp };
}

// Ubica cada postal según cuánto ha avanzado en el recorrido
function placePostcards() {
  if (!postcardLayout) return;
  const { W, cardW, cardH, rowLength, pathLength, spacing } = postcardLayout;

  postcardEls.forEach((el, i) => {
    const s = (postcardProgress + i * spacing) % pathLength;
    const leg = Math.floor(s / rowLength); // 0 = abajo, 1 = medio, 2 = arriba
    const t = s - leg * rowLength;         // avance dentro de esa fila
    const goingLeft = leg !== 1;           // abajo y arriba van hacia la izquierda
    const x = goingLeft ? W - t : -cardW + t;
    const row = 2 - leg;                   // fila en pantalla: 0 arriba ... 2 abajo
    const y = POSTCARD_GAP + row * (cardH + POSTCARD_GAP);
    el.style.transform = `translate(${x}px, ${y}px)`;
  });
}

function animatePostcards(time) {
  if (postcardLastTime !== null && !postcardsPaused && !postcardViewerOpen && postcardLayout) {
    postcardProgress += ((time - postcardLastTime) / 1000) * POSTCARD_SPEED;
    postcardProgress %= postcardLayout.pathLength;
  }
  postcardLastTime = time;
  placePostcards();
  requestAnimationFrame(animatePostcards);
}

function startPostcards() {
  const below = document.getElementById("below");
  below.addEventListener("mouseenter", () => { postcardsPaused = true; });  // se detienen al pasar el mouse
  below.addEventListener("mouseleave", () => { postcardsPaused = false; });

  // Visor: fondo que cubre el lado derecho + la postal en grande, con
  // frente (la foto) y reverso (los datos)
  postcardViewerEl = document.createElement("div");
  postcardViewerEl.id = "postcardViewer";
  postcardLargeEl = document.createElement("div");
  postcardLargeEl.className = "postcard-large";
  const inner = document.createElement("div");
  inner.className = "postcard-inner";
  postcardFrontEl = document.createElement("div");
  postcardFrontEl.className = "postcard-face postcard-front";
  const back = document.createElement("div");
  back.className = "postcard-face postcard-back";
  postcardBackEls = buildPostcardBack(back);
  inner.append(postcardFrontEl, back);
  postcardLargeEl.appendChild(inner);
  const hint = document.createElement("div");
  hint.id = "postcardHint";
  hint.textContent = "Toca la postal para darla vuelta";
  postcardViewerEl.append(postcardLargeEl, hint);
  below.appendChild(postcardViewerEl);

  // Tocar la postal la da vuelta; tocar fuera de ella (o Esc) la cierra
  postcardViewerEl.addEventListener("click", (e) => {
    if (postcardLargeEl.contains(e.target)) postcardLargeEl.classList.toggle("flipped");
    else closePostcard();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && postcardViewerOpen) closePostcard();
  });

  buildPostcards();
  // Si la persona pidió menos movimiento en su computador, quedan quietas
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduceMotion) requestAnimationFrame(animatePostcards);
}

// ---------------------------------------------------------------------
// SETUP
// ---------------------------------------------------------------------
function setup() {
  injectStyles();
  buildInterface();
  startPostcards();

  noStroke();
  noLoop(); // sin animación, solo redibuja cuando hace falta
  pixelDensity(1);

  bodyPixModel = ml5.bodyPix(CONFIG.bodyPixOptions, () => {
    modelReady = true;
    updateStatus("");
    redraw();
    if (photoReady && !maskReady) detectPerson(); // la foto llegó antes que el modelo
  });

  redraw();
}

// ---------------------------------------------------------------------
// INTERFAZ (panel lateral + marco de la foto)
// ---------------------------------------------------------------------
function injectStyles() {
  const css = `
    * { box-sizing: border-box; }
    html, body {
      margin: 0; padding: 0; height: 100%;
      background: #F4F4F4; color: #444444;
      font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      overflow: hidden;
    }
    /* La página: a la izquierda el panel (28% del ancho),
       a la derecha las filas de postales */
    #app { display: flex; width: 100vw; height: 100vh; }
    #panel {
      width: 28%; min-width: 280px; flex-shrink: 0;
      background: #EBEBEB; border-right: 1px solid #D6D6D6;
      padding: 20px; display: flex; flex-direction: column; gap: 18px;
      overflow-y: auto; /* si no cabe todo, el panel hace scroll */
    }
    #panel > * { flex-shrink: 0; }
    /* Secciones del panel, una debajo de otra */
    .col { display: flex; flex-direction: column; gap: 10px; }
    .col > * { flex-shrink: 0; }
    #title {
      font-size: 26px; font-weight: 600; line-height: 1.25; margin: 0;
      color: #333333;
    }
    .field-label {
      font-size: 16px; font-weight: 600; line-height: 1.2;
      color: #555555; margin: 0;
    }
    .primary-btn {
      display: block; width: 100%; text-align: center;
      padding: 10px 14px; background: #555555; color: #FFFFFF;
      border: none; border-radius: 5px; font-size: 13px; font-weight: 600;
      cursor: pointer; font-family: inherit;
    }
    .primary-btn:hover:not(:disabled) { background: #333333; }
    .primary-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    /* Los dos recuadros (vista previa y resultado) miden lo mismo:
       layoutBoxes() les da el mismo tamaño desde JavaScript */
    #previewBox {
      position: relative; background: transparent; border: none;
      padding: 6px;
    }
    #previewBox canvas { display: block; width: 100%; height: 100%; }
    /* Cuadro del poema como hoja de block: sin fondo, solo renglones */
    #poemInput {
      width: 100%; border: none; border-radius: 0;
      background-color: transparent;
      background-image: linear-gradient(to bottom, transparent 23px, #C4C4C4 23px);
      background-size: 100% 24px;
      background-attachment: local; /* los renglones se mueven con el texto */
      color: #444444; font-size: 14px; line-height: 24px; padding: 0 4px;
      resize: vertical; font-family: inherit;
    }
    #poemInput:focus { outline: none; }
    .btn-row { display: flex; gap: 8px; }
    .toggle-btn {
      flex: 1;
      padding: 8px 10px;
      background: #DADADA;
      border: 1px solid #DADADA;
      border-radius: 5px;
      font-size: 12px;
      font-weight: 600;
      color: #333333;
      cursor: pointer;
      font-family: inherit;
      transition: background 0.15s, border-color 0.15s, color 0.15s;
    }
    .toggle-btn:hover { border-color: #888888; }
    .toggle-btn-active {
      background: #888888;
      border-color: #888888;
      color: #FFFFFF;
    }
    #status { font-size: 12px; color: #666666; line-height: 1.4; }
    #previewSlot {
      min-width: 0; display: flex; align-items: center; justify-content: center;
      padding: 9px;
    }
    #poemInput { resize: none; }
    #stage {
      min-width: 0; min-height: 0; overflow: hidden; display: flex; align-items: center; justify-content: center;
      padding: 9px;
    }
    #canvasFrame {
      position: relative; padding: 6px;
      display: flex; align-items: center; justify-content: center;
    }
    #canvasFrame canvas {
      display: block;
    }
    .corner {
      position: absolute;
      width: 22px; height: 22px;
      pointer-events: none;
    }
    .corner-tl { top: -9px; left: -9px; border-top: 3px solid #999999; border-left: 3px solid #999999; }
    .corner-tr { top: -9px; right: -9px; border-top: 3px solid #999999; border-right: 3px solid #999999; }
    .corner-bl { bottom: -9px; left: -9px; border-bottom: 3px solid #999999; border-left: 3px solid #999999; }
    .corner-br { bottom: -9px; right: -9px; border-bottom: 3px solid #999999; border-right: 3px solid #999999; }

    /* Lado derecho: postales que recorren tres filas en zigzag.
       El movimiento lo hace placePostcards() desde JavaScript. */
    #below {
      flex: 1; min-width: 0; position: relative; overflow: hidden;
      background: #F4F4F4;
    }
    .postcard {
      position: absolute; top: 0; left: 0;
      border-radius: 4px; background: #D9D9D9;
      will-change: transform;
      display: flex; align-items: center; justify-content: center;
      font-size: 48px; font-weight: 700; color: rgba(0, 0, 0, 0.45); /* número de prueba */
    }
    .postcard:nth-child(3n + 2) { background: #C7C7C7; }
    .postcard:nth-child(3n + 3) { background: #E3E3E3; }
    .postcard { cursor: pointer; }
    /* Visor: la postal tocada, en grande y centrada en el lado derecho */
    #postcardViewer {
      position: absolute; inset: 0; z-index: 10;
      display: none; align-items: center; justify-content: center;
      flex-direction: column; gap: 14px;
      background: rgba(244, 244, 244, 0.65);
      cursor: pointer;
    }
    #postcardViewer.open { display: flex; animation: viewer-in 0.2s ease-out; }
    @keyframes viewer-in { from { opacity: 0; } to { opacity: 1; } }
    #postcardHint { font-size: 12px; color: #666666; }
    /* La postal grande tiene dos caras y gira al tocarla */
    .postcard-large { perspective: 1600px; cursor: pointer; }
    .postcard-inner {
      position: relative; width: 100%; height: 100%;
      transform-style: preserve-3d;
      transition: transform 0.6s ease;
    }
    .postcard-large.flipped .postcard-inner { transform: rotateY(180deg); }
    .postcard-face {
      position: absolute; inset: 0; border-radius: 6px;
      backface-visibility: hidden; -webkit-backface-visibility: hidden;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.18);
    }
    .postcard-front {
      background: #D9D9D9;
      display: flex; align-items: center; justify-content: center;
      font-size: calc(var(--h) * 0.3); font-weight: 700; color: rgba(0, 0, 0, 0.45);
    }
    /* Reverso: mensaje a la izquierda, línea al medio, datos a la derecha */
    .postcard-back {
      transform: rotateY(180deg);
      background: #FAFAF8; color: #444444;
      display: flex; padding: calc(var(--h) * 0.08);
      gap: calc(var(--h) * 0.06);
      font-size: calc(var(--h) * 0.045);
    }
    .pc-message { flex: 1; min-width: 0; }
    .pc-poem { margin-top: 0.6em; line-height: 1.5; }
    .pc-divider { width: 1px; background: #CCCCCC; }
    .pc-address { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .pc-stamp {
      align-self: flex-end;
      width: calc(var(--h) * 0.22); height: calc(var(--h) * 0.26);
      border: 2px dashed #AAAAAA; border-radius: 3px;
      display: flex; align-items: center; justify-content: center;
      font-size: 0.8em; color: #888888;
      margin-bottom: auto;
    }
    .pc-line {
      border-bottom: 1px solid #CCCCCC;
      padding: 0.5em 0 0.3em;
      display: flex; gap: 0.6em; align-items: baseline;
    }
    .pc-label {
      font-size: 0.7em; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.06em; color: #888888;
    }
    .pc-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  `;
  const styleEl = document.createElement("style");
  styleEl.innerHTML = css;
  document.head.appendChild(styleEl);
}

function buildInterface() {
  const appDiv = createDiv().id("app");
  const panel = createDiv().id("panel").parent(appDiv);

  // Panel izquierdo, de arriba abajo. Sección 1: título
  const colTitle = createDiv().id("colTitle").addClass("col").parent(panel);

  createElement("h1", "Ahora cada espacio de mí es un poema.")
    .id("title")
    .parent(colTitle);

  statusDiv = createDiv("Cargando modelo de segmentación…");
  statusDiv.id("status");
  statusDiv.parent(colTitle);

  // Sección 2: subir foto + vista previa
  const colPhoto = createDiv().id("colPhoto").addClass("col").parent(panel);

  // Input de archivo escondido; se activa con el botón de subir
  fileInputEl = createFileInput(handleFileSelected);
  fileInputEl.hide();
  fileInputEl.parent(colPhoto);

  uploadBtn = createButton("Subir autorretrato");
  uploadBtn.addClass("primary-btn");
  uploadBtn.parent(colPhoto);
  uploadBtn.mousePressed(() => fileInputEl.elt.click());

  // Vista previa: la foto con la zona detectada como retrato marcada
  const previewSlot = createDiv().id("previewSlot").parent(colPhoto);
  const previewBox = createDiv().id("previewBox").parent(previewSlot);
  previewCanvasEl = document.createElement("canvas");
  previewBox.elt.appendChild(previewCanvasEl);
  ["tl", "tr", "bl", "br"].forEach((pos) => {
    createDiv().addClass("corner corner-" + pos).parent(previewBox);
  });

  // Sección 3: poema + color de la letra
  const colPoem = createDiv().id("colPoem").addClass("col").parent(panel);

  createDiv("Escribe tu poema").addClass("field-label").parent(colPoem);

  const colorRow = createDiv().addClass("btn-row").parent(colPoem);

  textColorWhiteBtn = createButton("Letra blanca");
  textColorWhiteBtn.addClass("toggle-btn");
  textColorWhiteBtn.parent(colorRow);
  textColorWhiteBtn.mousePressed(() => setTextColor([255, 255, 255]));

  textColorBlackBtn = createButton("Letra negra");
  textColorBlackBtn.addClass("toggle-btn");
  textColorBlackBtn.parent(colorRow);
  textColorBlackBtn.mousePressed(() => setTextColor([0, 0, 0]));

  updateColorButtonsUI();

  poemTextarea = createElement("textarea", "");
  poemTextarea.id("poemInput");
  poemTextarea.attribute("rows", "6");
  poemTextarea.parent(colPoem);
  poemTextarea.input(() => schedulePoemRender());

  // Sección 4: resultado final (se genera solo) + guardar
  const colResult = createDiv().id("colResult").addClass("col").parent(panel);

  // Zona donde se muestra el resultado final
  const stage = createDiv().id("stage").parent(colResult);
  const canvasFrame = createDiv().id("canvasFrame").parent(stage);
  canvasFrameEl = canvasFrame;

  cnv = createCanvas(480, 320); // provisional, con forma de postal; se ajusta al subir la foto
  cnv.parent(canvasFrame);

  // Marcas decorativas en las esquinas
  ["tl", "tr", "bl", "br"].forEach((pos) => {
    createDiv().addClass("corner corner-" + pos).parent(canvasFrame);
  });

  // Guardar resultado
  saveBtnEl = createButton("Guardar imagen");
  saveBtnEl.addClass("primary-btn");
  saveBtnEl.parent(colResult);
  saveBtnEl.elt.disabled = true;
  saveBtnEl.mousePressed(onSaveClick);

  // Lado derecho: las postales (se crean y mueven en buildPostcards)
  createDiv().id("below").parent(appDiv);

  layoutBoxes(); // ahora que todo está armado, se puede medir
}

// ---------------------------------------------------------------------
// FOTO, POEMA Y BOTONES
// ---------------------------------------------------------------------
function handleFileSelected(file) {
  if (file.type !== "image") {
    updateStatus("Por favor selecciona un archivo de imagen.");
    return;
  }

  updateStatus("Cargando imagen…");

  loadImage(file.data, (img) => {
    originalImg = fitImageToMax(img, CONFIG.maxCanvasSize);
    resizeCanvas(originalImg.width, originalImg.height);
    layoutBoxes();

    photoReady = true;
    maskReady = false;
    maskImg = null;
    photoId++;
    appState = "vacio"; // ya hay foto, falta generar el retrato
    renderId++;         // descarta cualquier dibujo de la foto anterior
    clearPoemLayer();

    updateStatus("Autorretrato cargado.");
    refreshSaveButton();
    redraw();
    drawPreview();
    if (modelReady) detectPerson();
  });
}

// Detecta a la persona en la foto actual y arma la máscara. Se hace
// apenas se sube la foto, para mostrarla en la vista previa.
function detectPerson() {
  const myPhotoId = photoId;
  updateStatus("Detectando tu retrato…");

  bodyPixModel.segment(originalImg, (err, result) => {
    if (myPhotoId !== photoId) return; // subieron otra foto mientras tanto
    if (err) {
      console.error(err);
      updateStatus("Error al detectar el retrato. Revisa la consola del navegador.");
      return;
    }

    buildMask(result, () => {
      if (myPhotoId !== photoId) return;
      maskReady = true;
      updateStatus("Retrato detectado.");
      drawPreview();
      renderPoem(); // si ya había poema, se plasma de inmediato
    });
  });
}

// Dibuja la foto dentro del recuadro de vista previa (sin deformarla) y,
// si ya se detectó, marca en gris oscuro la zona considerada retrato.
function drawPreview() {
  if (!previewCanvasEl) return;

  const boxW = previewCanvasEl.clientWidth;
  const boxH = previewCanvasEl.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  previewCanvasEl.width = Math.round(boxW * dpr);
  previewCanvasEl.height = Math.round(boxH * dpr);

  const ctx = previewCanvasEl.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, boxW, boxH);
  if (!photoReady) return;

  const imgW = originalImg.width;
  const imgH = originalImg.height;
  const scale = Math.min(boxW / imgW, boxH / imgH);
  const drawW = imgW * scale;
  const drawH = imgH * scale;
  const x = (boxW - drawW) / 2;
  const y = (boxH - drawH) / 2;

  ctx.drawImage(originalImg.canvas, x, y, drawW, drawH);

  if (maskReady && maskImg) {
    // Pinta de gris oscuro solo donde la máscara dice "persona"
    const tint = document.createElement("canvas");
    tint.width = imgW;
    tint.height = imgH;
    const tctx = tint.getContext("2d");
    tctx.drawImage(maskImg.canvas, 0, 0);
    tctx.globalCompositeOperation = "source-in";
    tctx.fillStyle = "#222222";
    tctx.fillRect(0, 0, imgW, imgH);

    ctx.globalAlpha = 0.5;
    ctx.drawImage(tint, x, y, drawW, drawH);
    ctx.globalAlpha = 1;
  }
}

// Solo deja guardar cuando ya hay un retrato terminado
function refreshSaveButton() {
  if (saveBtnEl) saveBtnEl.elt.disabled = !(appState === "listo");
}

function updateStatus(msg) {
  if (statusDiv) statusDiv.html(msg);
}

// Achica la imagen solo si CONFIG.maxCanvasSize tiene un valor definido.
// Por defecto no se toca, para conservar la calidad original de la foto.
function fitImageToMax(img, maxSize) {
  if (!maxSize) return img;

  const w = img.width;
  const h = img.height;
  const scale = Math.min(1, maxSize / Math.max(w, h));
  if (scale < 1) {
    img.resize(Math.round(w * scale), Math.round(h * scale));
  }
  return img;
}

// Cambia el color del poema y lo vuelve a dibujar al instante
// (sin repetir la detección de la persona).
function setTextColor(rgb) {
  CONFIG.textColor = rgb;
  updateColorButtonsUI();

  renderPoem();
}

// Muestra cuál color está elegido
function updateColorButtonsUI() {
  const isWhite = CONFIG.textColor[0] === 255 && CONFIG.textColor[1] === 255 && CONFIG.textColor[2] === 255;

  if (textColorWhiteBtn) {
    if (isWhite) textColorWhiteBtn.addClass("toggle-btn-active");
    else textColorWhiteBtn.removeClass("toggle-btn-active");
  }
  if (textColorBlackBtn) {
    if (!isWhite) textColorBlackBtn.addClass("toggle-btn-active");
    else textColorBlackBtn.removeClass("toggle-btn-active");
  }
}

// Descarga la imagen final (foto + poema)
function onSaveClick() {
  if (appState !== "listo") return;
  const filename = "retrato-poema-" + Date.now();
  saveCanvas(cnv, filename, "png");
}

// ---------------------------------------------------------------------
// ARMAR EL RETRATO (detectar persona + acomodar el poema)
// ---------------------------------------------------------------------
// Espera un momento a que dejes de escribir y luego dibuja el poema,
// para no recalcular con cada letra.
function schedulePoemRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderPoem, 500);
}

// Dibuja el poema sobre la silueta con lo que haya en este momento.
// Se llama sola cada vez que cambia la foto, el poema o el color.
function renderPoem() {
  clearTimeout(renderTimer);
  if (!photoReady || !maskReady) return; // falta foto o todavía se detecta la persona

  const myRenderId = ++renderId;
  const poemText = poemTextarea.value().trim();

  // Sin poema: se muestra solo la foto
  if (poemText.length === 0) {
    appState = "vacio";
    clearPoemLayer();
    refreshSaveButton();
    redraw();
    return;
  }

  appState = "procesando";
  refreshSaveButton();
  updateStatus("Acomodando el poema sobre la silueta…");

  buildPoemLines(poemText, () => myRenderId !== renderId, (layer) => {
    if (myRenderId !== renderId) {
      layer.remove(); // llegó un cambio más nuevo; este dibujo ya no sirve
      return;
    }
    clearPoemLayer();
    gridLayer = layer;
    appState = "listo";
    updateStatus("Poema plasmado en el autorretrato.");
    refreshSaveButton();
    redraw();
  });
}

// Borra la capa del poema anterior (y libera su memoria)
function clearPoemLayer() {
  if (gridLayer) gridLayer.remove();
  gridLayer = null;
}

// Marca qué píxeles son persona y cuáles son fondo
function buildMask(result, onComplete) {
  const w = originalImg.width;
  const h = originalImg.height;
  const segData = result.segmentation.data; // 1 = persona, 0 = fondo

  maskImg = createImage(w, h);
  maskImg.loadPixels();

  const PIXEL_CHUNK_SIZE = 20000;

  runChunked(w * h, PIXEL_CHUNK_SIZE, (i) => {
    const isPerson = segData[i] === 1 || segData[i] === 255;
    const idx = i * 4;
    maskImg.pixels[idx]     = 255;
    maskImg.pixels[idx + 1] = 255;
    maskImg.pixels[idx + 2] = 255;
    maskImg.pixels[idx + 3] = isPerson ? 255 : 0;
  }, () => {
    maskImg.updatePixels();
    if (CONFIG.maskFeather > 0) {
      maskImg.filter(BLUR, CONFIG.maskFeather);
    }
    onComplete();
  });
}

// Separa el poema en palabras
function poemToWords(poemText) {
  const cleaned = poemText.replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned.split(" ") : ["(poema vacío)"];
}

// En una fila de la imagen, encuentra los tramos que son parte del
// cuerpo (puede haber más de uno). Ignora huequitos chicos.
function scanRowSegments(mask, y, threshold, minWidth, maxGap) {
  const w = mask.width;
  const rowOffset = y * w;

  const segments = [];
  let inSegment = false;
  let segStart = 0;
  let lastAboveX = -1;

  for (let x = 0; x < w; x++) {
    const alpha = mask.pixels[(rowOffset + x) * 4 + 3];
    const above = alpha > threshold;

    if (above) {
      if (!inSegment) {
        inSegment = true;
        segStart = x;
      }
      lastAboveX = x;
    } else if (inSegment && (x - lastAboveX) > maxGap) {
      segments.push([segStart, lastAboveX]);
      inSegment = false;
    }
  }
  if (inSegment) segments.push([segStart, lastAboveX]);

  return segments.filter(([a, b]) => (b - a) >= minWidth);
}

// Recorre el cuerpo fila por fila y va llenando cada tramo con
// palabras del poema, ajustándolas al ancho disponible. Dibuja en una
// capa nueva y la entrega al terminar; isStale() dice si ya no hace falta.
function buildPoemLines(poemText, isStale, onComplete) {
  maskImg.loadPixels();

  const w = maskImg.width;
  const h = maskImg.height;

  // Escala todo (letra, espaciado, umbrales) según qué tan grande es
  // la foto comparada con el tamaño de referencia, para que el poema
  // se vea igual de proporcionado sin importar la resolución.
  const scale = Math.max(w, h) / CONFIG.referenceSize;
  const fontSize = CONFIG.fontSize * scale;
  const lineSpacing = CONFIG.lineSpacing * scale;
  const minSegmentWidth = CONFIG.minSegmentWidth * scale;
  const maxRowGap = CONFIG.maxRowGap * scale;

  const threshold = CONFIG.cellCoverageThreshold;
  const words = poemToWords(poemText);

  const layer = createGraphics(w, h);
  layer.clear();
  layer.textFont(CONFIG.fontFamily);
  layer.textSize(fontSize);
  layer.textStyle(BOLD);
  layer.textAlign(CENTER, CENTER);

  const spaceWidth = layer.textWidth(" ");
  let wordCursor = 0;

  function fillSegment(xStart, xEnd, y) {
    const availableWidth = xEnd - xStart;
    let line = "";
    let usedWidth = 0;
    let wordsUsed = 0;
    const maxWordsPerLine = 200;

    while (wordsUsed < maxWordsPerLine) {
      const word = words[wordCursor % words.length];
      const wordWidth = layer.textWidth(word);
      const extra = line.length > 0 ? spaceWidth : 0;

      if (usedWidth + extra + wordWidth > availableWidth) break;

      line += (line.length > 0 ? " " : "") + word;
      usedWidth += extra + wordWidth;
      wordCursor++;
      wordsUsed++;
    }

    if (line.length === 0) return;

    if (CONFIG.showGrid) {
      layer.push();
      layer.stroke(
        CONFIG.gridLineColor[0],
        CONFIG.gridLineColor[1],
        CONFIG.gridLineColor[2],
        CONFIG.gridLineAlpha
      );
      layer.strokeWeight(1);
      layer.line(xStart, y, xEnd, y);
      layer.pop();
    }

    const cx = xStart + availableWidth / 2;
    drawLineText(layer, line, cx, y);
  }

  const rows = [];
  for (let y = lineSpacing; y < h; y += lineSpacing) {
    rows.push(Math.floor(y));
  }

  runChunked(rows.length, 30, (i) => {
    if (isStale()) return; // no sigue trabajando en un dibujo descartado
    const y = rows[i];
    const segments = scanRowSegments(maskImg, y, threshold, minSegmentWidth, maxRowGap);
    for (const [xStart, xEnd] of segments) {
      fillSegment(xStart, xEnd, y);
    }
  }, () => onComplete(layer));
}

// Reglas de color: cada color de letra tiene su sombra fija, para que
// siempre haya contraste sobre la foto.
const SHADOW_COLOR = {
  blanca: [0, 0, 0],
  negra: [255, 255, 255]
};

// Dibuja una línea de texto con su sombra correspondiente detrás,
// para que se lea bien encima de la foto. Blanca -> sombra negra.
// Negra -> sombra blanca.
function drawLineText(layer, line, cx, cy) {
  const isWhiteText =
    CONFIG.textColor[0] === 255 &&
    CONFIG.textColor[1] === 255 &&
    CONFIG.textColor[2] === 255;

  const shadow = isWhiteText ? SHADOW_COLOR.blanca : SHADOW_COLOR.negra;

  if (CONFIG.textOutline) {
    layer.fill(shadow[0], shadow[1], shadow[2], 160);
    layer.text(line, cx + 1, cy + 1);
  }
  layer.fill(
    CONFIG.textColor[0],
    CONFIG.textColor[1],
    CONFIG.textColor[2],
    CONFIG.textAlpha
  );
  layer.text(line, cx, cy);
}

// ---------------------------------------------------------------------
// DIBUJO (sin animación, solo redibuja cuando cambia algo)
// ---------------------------------------------------------------------
function draw() {
  if (!photoReady) {
    drawWaitingScreen();
    return;
  }

  image(originalImg, 0, 0);

  if (gridLayer) {
    image(gridLayer, 0, 0);
  }
}

function drawWaitingScreen() {
  background(244, 244, 244);

  if (!modelReady) {
    fill(68, 68, 68);
    textAlign(CENTER, CENTER);
    textSize(16);
    text("Cargando modelo de segmentación…", width / 2, height / 2);
  }
}

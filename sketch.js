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
  edgeMargin: 40,              // margen sin texto junto a los bordes de la foto, para que
                                // ninguna palabra quede cortada (a tamaño de referencia)
  referenceSize: 900,          // tamaño de foto para el que estos valores están pensados;
                                // con fotos más grandes o chicas, todo escala proporcionalmente

  showGrid: false,             // true = muestra líneas guía (para probar)
  gridLineColor: [255, 255, 255],
  gridLineAlpha: 55,

  fontFamily: "Courier New",   // un solo nombre: p5 lo pone entre comillas, así que no admite una lista
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
let fileInputEl, poemTextarea, cnv, canvasFrameEl;
let colorButtonPairs = [];  // botones "Letra blanca / Letra negra" (bajo la foto en grande)
let previewCanvasEl;
let finalRows = [];   // filas con "Guardar imagen" y "Enviar mi postal" (en las vistas en grande)
let lastPoemLines = [];                  // líneas del último poema armado (para animarlo)
let maskEditorEl, maskEditorCanvasEl;    // ventana para pintar/borrar la silueta en grande
let maskEditorPaintBtn, maskEditorEraseBtn;
let maskEditorOpen = false;
let brushMode = "paint";                 // "paint" (agrega silueta) o "erase" (quita)
let maskEditorFit = null;                // dónde y a qué escala está la foto en el editor
let shareDialogEl, shareCopyEl;

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
  const BOX_SCALE = isMobile() ? 0.96 : 0.62; // los recuadros ocupan un poco menos que el ancho disponible
  // En el teléfono solo se ve una etapa (las otras están escondidas y miden 0),
  // así que se mide el panel, menos el margen de 9px a cada lado de los recuadros
  const available = isMobile()
    ? innerWidth(panelEl) - 18
    : Math.min(innerWidth(stageEl), innerWidth(slotEl));
  let boxW = Math.max(0, Math.floor(available * BOX_SCALE));
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
  // El cuadro del poema tiene el mismo ancho (su alto lo dan los renglones)
  const poemBoxEl = document.getElementById("poemBox");
  if (poemBoxEl) poemBoxEl.style.width = boxW + "px";

  // El canvas del resultado cabe dentro del recuadro (menos su borde interno)
  const frameStyle = getComputedStyle(canvasFrameEl.elt);
  const innerW = boxW - parseFloat(frameStyle.paddingLeft) - parseFloat(frameStyle.paddingRight);
  const innerH = boxH - parseFloat(frameStyle.paddingTop) - parseFloat(frameStyle.paddingBottom);
  const scale = Math.min(1, innerW / width, innerH / height);
  cnv.elt.style.width = Math.floor(width * scale) + "px";
  cnv.elt.style.height = Math.floor(height * scale) + "px";
}

// ---------------------------------------------------------------------
// TELÉFONO
// En pantallas chicas el panel va arriba, las postales debajo (la página
// hace scroll) y las vistas en grande ocupan toda la pantalla.
// Debe coincidir con el @media del final de injectStyles().
// ---------------------------------------------------------------------
const MOBILE_QUERY = "(max-width: 700px), (max-height: 500px) and (orientation: landscape)";
function isMobile() {
  return window.matchMedia(MOBILE_QUERY).matches;
}

// Espacio disponible para las vistas en grande: en el teléfono toda la
// pantalla; en el computador, el lado derecho
function viewerArea() {
  if (isMobile()) return { w: window.innerWidth, h: window.innerHeight };
  const below = document.getElementById("below");
  return { w: below.clientWidth, h: below.clientHeight };
}

// Alto de referencia para las letras del reverso. En el teléfono la postal
// es angosta, así que se permite que crezcan un poco más (si cabe a lo alto)
function backTextHeight(w, h) {
  return Math.min(h, w / (isMobile() ? 1.15 : POSTCARD_RATIO));
}

// Con una vista en grande abierta, la página de atrás no hace scroll
function updateScrollLock() {
  // (en el teléfono el editor va dentro de la página, así que ahí sí se puede hacer scroll)
  const open = (maskEditorOpen && !isMobile()) || resultViewerOpen || postcardViewerOpen;
  document.body.classList.toggle("viewer-open", open);
}

// En el teléfono, el título y la descripción van arriba de todo, sobre la
// fila de postales; en el computador, al comienzo del panel
function placeTitle() {
  const titleEl = document.getElementById("colTitle");
  const appEl = document.getElementById("app");
  const panelEl = document.getElementById("panel");
  if (!titleEl || !appEl || !panelEl) return;
  if (isMobile()) {
    if (titleEl.parentElement !== appEl) appEl.insertBefore(titleEl, appEl.firstChild);
  } else if (titleEl.parentElement !== panelEl) {
    panelEl.insertBefore(titleEl, panelEl.firstChild);
  }
}

function windowResized() {
  placeTitle();
  placeMaskEditor();
  updateScrollLock();
  updateStepUI();
  layoutBoxes();
  drawPreview();
  sizeMaskEditor();
  buildPostcards();
}

// ---------------------------------------------------------------------
// POSTALES (lado derecho)
// Recorren tres filas en zigzag: entran abajo a la derecha y van hacia
// la izquierda; al salir, aparecen en la fila del medio y van de
// izquierda a derecha; al salir, pasan a la fila de arriba y van de
// derecha a izquierda. Al salir de arriba vuelven a entrar abajo.
// Las obras se leen de postales/postales.json (ver postales/LEEME.txt);
// si no hay ninguna, se muestran postales de muestra.
// ---------------------------------------------------------------------
const POSTCARD_GAP = 24;   // espacio entre postales y entre filas (px)
const POSTCARD_SPEED = 40; // velocidad (px por segundo)
const POSTCARD_HOVER_SPEED = 12; // velocidad más lenta con el mouse encima (px por segundo)
const POSTCARD_RATIO = 3 / 2; // ancho / alto, como una foto normal (10x15 cm)
const POSTCARD_TEST_COLORS = true; // prueba: cada postal con color y número propio, para seguir su recorrido

let postcardEls = [];
let postcardLayout = null;
let postcardProgress = 0;  // cuánto ha avanzado la fila completa
let postcardLastTime = null;
let postcardMouse = null;        // posición del cursor sobre las postales (o null si está fuera)
let postcardCurrentSpeed = POSTCARD_SPEED; // cambia suave entre rápido y lento
let postcardViewerOpen = false;  // hay una postal abierta en grande
let postcardViewerEl, postcardLargeEl, postcardFrontEl, postcardBackEls;
let largePostcardImage = null;   // tamaño real de la foto abierta en grande
let galleryEntries = [];         // obras de la carpeta postales/ (1.jpg, 2.jpg, ...)
const GALLERY_MAX = 500;         // tope de seguridad al buscar imágenes numeradas

// Revisa si existe una imagen (sin descargarla dos veces: el navegador la guarda)
function imageExists(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = src;
  });
}

// Busca las postales numeradas en orden: postales/1.jpg, 2.jpg, 3.jpg...
// y se detiene en el primer número que falte. Los datos de cada una
// (nombre, desde, fecha, poema) se leen de postales/postales.json,
// usando el mismo número. Si no hay imágenes, quedan las de muestra.
async function loadGallery() {
  let data = {};
  try {
    const res = await fetch("postales/postales.json", { cache: "no-cache" });
    if (res.ok) {
      const json = await res.json();
      if (json && typeof json === "object" && !Array.isArray(json)) data = json;
    }
  } catch (err) {
    console.warn("No se pudo leer postales/postales.json; las postales se muestran sin datos.", err);
  }

  const entries = [];
  for (let n = 1; n <= GALLERY_MAX; n++) {
    const imagen = n + ".jpg";
    if (!(await imageExists("postales/" + imagen))) break;
    const info = data[String(n)] || {};
    entries.push({ numero: n, imagen, ...info });
  }
  galleryEntries = entries;
}

// Crea tantas postales como caben a lo largo del recorrido completo
function buildPostcards() {
  const below = document.getElementById("below");
  if (!below) return;
  const W = below.clientWidth;
  const H = below.clientHeight;
  // En el teléfono, al hacer scroll aparece y desaparece la barra del
  // navegador y eso cuenta como "cambio de tamaño": si nada cambió, no se rearma
  // En el computador, tres filas en zigzag; en el teléfono, una sola fila
  // de postales chicas arriba
  const rows = isMobile() ? 1 : 3;
  const gap = isMobile() ? 10 : POSTCARD_GAP;
  const buildKey = W + "x" + H + "x" + galleryEntries.length + "x" + rows;
  if (buildKey === buildPostcards.lastKey && postcardEls.length) {
    if (postcardViewerOpen) sizeLargePostcard();
    return;
  }
  buildPostcards.lastKey = buildKey;
  postcardEls.forEach((el) => el.remove());

  const cardH = Math.max(40, (H - gap * (rows + 1)) / rows); // las filas + espacios
  const cardW = cardH * POSTCARD_RATIO;
  const rowLength = W + cardW;         // de totalmente afuera a un lado, a totalmente afuera al otro
  const pathLength = rowLength * rows; // las filas seguidas
  const count = Math.max(1, Math.floor(pathLength / (cardW + gap)));

  postcardLayout = { W, cardW, cardH, rowLength, pathLength, rows, gap, spacing: pathLength / count };
  postcardEls = [];
  for (let i = 0; i < count; i++) {
    const el = document.createElement("div");
    el.className = "postcard";
    el.style.width = cardW + "px";
    el.style.height = cardH + "px";

    if (galleryEntries.length > 0 && i >= galleryEntries.length) {
      // Espacio todavía sin obra: postal vacía, sin número y sin abrir
      el.classList.add("postcard-empty");
    } else if (galleryEntries.length > 0) {
      // Obra real, cada una una sola vez
      const entry = galleryEntries[i];
      el.style.backgroundImage = `url("postales/${encodeURI(entry.imagen)}")`;
      // Opcional: qué parte de la foto se ve en la postal chica (de 0 = arriba
      // a 100 = abajo). Más alto = la foto sube y se ve más de la parte de abajo
      const pos = Number(entry.posicion);
      if (entry.posicion !== undefined && isFinite(pos)) {
        el.style.backgroundPosition = "center " + Math.max(0, Math.min(100, pos)) + "%";
      }
      el.postcardData = {
        number: entry.numero,
        image: "postales/" + entry.imagen,
        name: entry.nombre || "",
        place: entry.desde || "",
        date: entry.fecha || "",
        poem: entry.poema || "",
        poemAuthor: entry.autor || entry.nombre || "", // autor/a del poema (si no se indica, quien envía)
        backColor: entry.color || "" // color del reverso (opcional)
      };
    } else {
      // Postales de muestra
      if (POSTCARD_TEST_COLORS) {
        // Solo colores fríos: del verde agua (170) al violeta (270)
        el.style.background = `hsl(${Math.round(170 + (i * 100) / count)}, 50%, 72%)`;
        el.textContent = i + 1;
      }
      el.postcardData = {
        number: i + 1,
        name: `Persona ${i + 1}`,
        place: "Ciudad, país",
        date: "Fecha de envío",
        poem: "Aquí irá un fragmento del poema que esta persona plasmó en su autorretrato."
      };
    }
    if (el.postcardData) el.addEventListener("click", () => openPostcard(el));
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
  largePostcardImage = null;
  if (data.image) {
    // La obra completa, sin recortar: la postal grande toma la forma de la foto
    postcardFrontEl.style.background = `#E6E6E6 url("${encodeURI(data.image)}") center / contain no-repeat`;
    const img = new Image();
    img.onload = () => {
      if (!postcardViewerOpen) return;
      largePostcardImage = { w: img.naturalWidth, h: img.naturalHeight };
      sizeLargePostcard();
    };
    img.src = data.image;
  }
  postcardFrontEl.textContent = el.textContent;

  // Se usa textContent (no innerHTML) porque estos datos los escriben
  // otras personas
  // Cada postal puede tener su propio color atrás; si no, queda el de siempre
  postcardLargeEl.querySelector(".postcard-back").style.backgroundColor = data.backColor || "";
  postcardBackEls.poem.textContent = data.poem;
  postcardBackEls.author.textContent = data.poemAuthor ? "Poema por: " + data.poemAuthor : "";
  postcardBackEls.name.textContent = data.name;
  postcardBackEls.place.textContent = data.place;
  postcardBackEls.date.textContent = data.date;

  postcardLargeEl.classList.remove("flipped");
  postcardViewerEl.classList.add("open");
  sizeLargePostcard(); // ya abierta, para poder medir si el poema cabe
  updateScrollLock();
}

function closePostcard() {
  postcardViewerOpen = false;
  postcardViewerEl.classList.remove("open");
  updateScrollLock();
}

// La postal abierta se ve con las proporciones reales de la foto, lo más
// grande que quepa en el lado derecho (con margen), pero nunca más grande
// que la foto misma. --h sirve para que las letras del reverso escalen.
function sizeLargePostcard() {
  const area = viewerArea();
  const maxW = area.w * (isMobile() ? 0.92 : 0.65);
  const maxH = area.h * (isMobile() ? 0.72 : 0.65);
  const ratio = largePostcardImage ? largePostcardImage.w / largePostcardImage.h : POSTCARD_RATIO;
  let w = Math.min(maxW, maxH * ratio);
  if (largePostcardImage) w = Math.min(w, largePostcardImage.w);
  const h = w / ratio;
  postcardLargeEl.style.width = w + "px";
  postcardLargeEl.style.height = h + "px";
  // Las letras del reverso escalan como en una postal 3:2 de este ancho,
  // para que no se agranden de más si la foto es más alta
  postcardLargeEl.style.setProperty("--h", backTextHeight(w, h) + "px");
  fitPoemText(postcardBackEls.poem);
}

// Si el poema no cabe en el reverso (sobre "Poema por"), achica un poco
// su letra hasta que quepa entero
function fitPoemText(poemEl) {
  if (!poemEl) return;
  const box = poemEl.parentElement; // .pc-message: poema + "Poema por"
  let em = 0.85;                    // tamaño normal (ver .pc-poem)
  poemEl.style.fontSize = em + "em";
  if (!box.clientHeight) return;    // todavía no se ve: se ajusta al abrir
  while (box.scrollHeight > box.clientHeight + 1 && em > 0.35) {
    em *= 0.95;
    poemEl.style.fontSize = em + "em";
  }
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
  const poem = make("pc-poem", message);
  const author = make("pc-author", message); // "Poema por: ..." en pequeño, bajo el poema

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

  return { poem, author, name, place, date, stamp };
}

// Ubica cada postal según cuánto ha avanzado en el recorrido
function placePostcards() {
  if (!postcardLayout) return;
  const { W, cardW, cardH, rowLength, pathLength, rows, gap, spacing } = postcardLayout;

  postcardEls.forEach((el, i) => {
    const s = (postcardProgress + i * spacing) % pathLength;
    const leg = Math.floor(s / rowLength); // 0 = abajo, 1 = medio, 2 = arriba
    const t = s - leg * rowLength;         // avance dentro de esa fila
    const goingLeft = leg % 2 === 0;       // abajo y arriba van hacia la izquierda
    const x = goingLeft ? W - t : -cardW + t;
    const row = rows - 1 - leg;            // fila en pantalla: 0 arriba ... 2 abajo
    const y = gap + row * (cardH + gap);
    el.style.transform = `translate(${x}px, ${y}px)`;
  });
}

// ¿El cursor está sobre una postal que se puede abrir? (las vacías no cuentan)
function cursorOnPhoto() {
  if (!postcardMouse) return false;
  const el = document.elementFromPoint(postcardMouse.x, postcardMouse.y);
  const card = el && el.closest(".postcard");
  return !!(card && card.postcardData);
}

function animatePostcards(time) {
  if (postcardLastTime !== null && !postcardViewerOpen && !(maskEditorOpen && !isMobile()) && !resultViewerOpen && postcardLayout) {
    const dt = (time - postcardLastTime) / 1000;
    // Con el cursor sobre una foto van más lento (sin detenerse); el cambio es gradual
    const target = cursorOnPhoto() ? POSTCARD_HOVER_SPEED : POSTCARD_SPEED;
    postcardCurrentSpeed += (target - postcardCurrentSpeed) * Math.min(1, dt * 4);
    postcardProgress += dt * postcardCurrentSpeed;
    postcardProgress %= postcardLayout.pathLength;
  }
  postcardLastTime = time;
  placePostcards();
  requestAnimationFrame(animatePostcards);
}

function startPostcards() {
  const below = document.getElementById("below");
  // Se guarda dónde está el cursor; en cada cuadro se revisa si está sobre
  // una postal (las postales se mueven, aunque el mouse esté quieto)
  below.addEventListener("mousemove", (e) => { postcardMouse = { x: e.clientX, y: e.clientY }; });
  below.addEventListener("mouseleave", () => { postcardMouse = null; });

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

  loadGallery().then(buildPostcards); // primero lee las obras, luego arma las postales
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
  buildShareDialog();
  startPostcards();

  noStroke();
  noLoop(); // sin animación, solo redibuja cuando hace falta
  pixelDensity(1);
  layoutBoxes(); // pixelDensity() devuelve el canvas a su tamaño original (en pantallas retina); se vuelve a ajustar

  bodyPixModel = ml5.bodyPix(CONFIG.bodyPixOptions, () => {
    modelReady = true;
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
      background: #F3EDDC; color: #444444;
      font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      overflow: hidden;
    }
    /* La página: a la izquierda el panel (28% del ancho),
       a la derecha las filas de postales */
    #app { display: flex; width: 100vw; height: 100vh; }
    #panel {
      width: 28%; min-width: 280px; flex-shrink: 0;
      background: #F7E6E3; border-right: 1px solid #E8D2CE; /* rosadito muy claro */
      padding: 20px; display: flex; flex-direction: column; gap: 0;
      /* título arriba; foto debajo; poema y resultado se reparten el alto */
      overflow-y: auto; /* si no cabe todo, el panel hace scroll */
    }
    #panel > * { flex-shrink: 0; }
    /* Secciones del panel, una debajo de otra */
    .col { display: flex; flex-direction: column; gap: 10px; }
    #colTitle { padding-bottom: 16px; gap: 8px; }
    #subtitle { margin: 0; font-size: 13px; line-height: 1.45; color: #B5543A; } /* descripción breve bajo el título */
    /* Cada sección es una franja de borde a borde del panel, sin esquinas
       redondeadas; las tres se reparten el alto hasta abajo. La de la etapa
       actual se colorea. */
    .step-card {
      flex: 1 1 0; justify-content: center;          /* las tres franjas, del mismo alto */
      margin: 0 -20px; padding: 14px 20px;          /* llega a los bordes del panel */
      border-top: 1px solid #E8D2CE;
      background: transparent;
      transition: background 0.3s;
    }
    #colResult { margin-bottom: -20px; }            /* la última llega hasta abajo */
    .step-card.active {
      background: rgba(181, 84, 58, 0.12); /* terracota muy suave */
    }
    .step-card.active .field-label { color: #B5543A; }
    /* Títulos de sección iguales a la barra del teléfono: "1 Retrato", "2 Poema", "3 Postal" */
    .step-card .field-label { display: flex; align-items: center; gap: 8px; }
    .step-card .field-label .step-num { width: 22px; height: 22px; font-size: 12px; }
    .step-card.active .field-label .step-num { background: #B5543A; color: #FFFFFF; }
    .col > * { flex-shrink: 0; }
    #title {
      font-size: 26px; font-weight: 600; line-height: 1.25; margin: 0;
      color: #B5543A; /* terracota */
    }
    .field-label {
      font-size: 16px; font-weight: 600; line-height: 1.2;
      color: #555555; margin: 0;
    }
    .primary-btn {
      display: block; width: 100%; text-align: center;
      padding: 10px 14px; background: #7B5B45; color: #FFFFFF; /* café, como los textos de ayuda */
      border: none; border-radius: 5px; font-size: 13px; font-weight: 600;
      cursor: pointer; font-family: inherit;
    }
    .primary-btn:hover:not(:disabled) { background: #5E4433; }
    .primary-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    /* Los dos recuadros (vista previa y resultado) miden lo mismo:
       layoutBoxes() les da el mismo tamaño desde JavaScript */
    #previewBox {
      position: relative; background: transparent; border: none;
      padding: 6px;
    }
    #previewBox canvas { display: block; width: 100%; height: 100%; }
    /* El recuadro de la vista previa es también el botón para subir la foto */
    #previewBox { cursor: pointer; }
    #previewBox:focus-visible { outline: 2px solid #B5543A; outline-offset: 12px; }
    /* Fondo hueso que llega justo hasta el borde de las esquinas (9px afuera) */
    #previewBox::before {
      content: ""; position: absolute; inset: -9px;
      background: #F3EDDC;
    }
    #previewBox canvas { position: relative; } /* encima del fondo */
    #uploadLabel {
      position: absolute; inset: 0;
      display: flex; align-items: center; justify-content: center;
      color: #A89F8C; /* ícono de retrato, tono suave sobre el hueso */
      pointer-events: none;
    }
    #uploadLabel svg {
      width: 34%; height: 34%;
      fill: none; stroke: currentColor; stroke-width: 2.5; stroke-linecap: round;
    }
    #previewBox:hover #uploadLabel { color: #B5543A; }
    #previewBox.has-photo #uploadLabel { display: none; }
    .toggle-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    #photoError { font-size: 12px; line-height: 1.4; color: #B5543A; text-align: center; padding: 0 6px; }
    /* Cuadro hueso con esquinas para los renglones del poema */
    #poemBox { position: relative; padding: 6px; margin: 9px auto; } /* centrado, como los otros */
    #poemBox::before {
      content: ""; position: absolute; inset: -9px;
      background: #F3EDDC;
    }
    #poemBox textarea { position: relative; } /* encima del fondo */
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
      background: #E6D9CC;          /* café clarito */
      border: 1px solid #E6D9CC;
      border-radius: 5px;
      font-size: 12px;
      font-weight: 600;
      color: #5E4433;
      cursor: pointer;
      font-family: inherit;
      transition: background 0.15s, border-color 0.15s, color 0.15s;
    }
    .toggle-btn:hover { border-color: #7B5B45; }
    .toggle-btn-active {
      background: #7B5B45;
      border-color: #7B5B45;
      color: #FFFFFF;
    }
    #previewSlot {
      min-width: 0; display: flex; align-items: center; justify-content: center;
      padding: 9px;
    }
    #poemInput { resize: none; height: 96px; overflow-y: auto; } /* 4 renglones de 24px; si hay más, scroll */
    #stage {
      min-width: 0; min-height: 0; overflow: hidden; display: flex; align-items: center; justify-content: center;
      padding: 9px;
    }
    #canvasFrame {
      position: relative; padding: 6px;
      display: flex; align-items: center; justify-content: center;
    }
    /* Fondo hueso que llega justo hasta el borde de las esquinas (9px afuera) */
    #canvasFrame::before {
      content: ""; position: absolute; inset: -9px;
      background: #F3EDDC;
    }
    #canvasFrame canvas { position: relative; } /* encima del fondo */
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
      background: #F3EDDC;
    }
    .postcard {
      position: absolute; top: 0; left: 0;
      border-radius: 4px; background: #D9D9D9;
      background-size: cover; background-position: center 40%; /* la obra llena la postal (50% = centrada; menos % = la foto baja) */
      will-change: transform;
      display: flex; align-items: center; justify-content: center;
      font-size: 48px; font-weight: 700; color: rgba(0, 0, 0, 0.45); /* número de prueba */
    }
    .postcard:nth-child(3n + 2) { background-color: #C7C7C7; }
    .postcard:nth-child(3n + 3) { background-color: #E3E3E3; }
    .postcard { cursor: pointer; }
    .postcard.postcard-empty { cursor: default; }
    /* Ventanita para enviar la postal por correo */
    #shareDialog {
      position: fixed; inset: 0; z-index: 20;
      display: none; align-items: center; justify-content: center;
      background: rgba(60, 60, 60, 0.35);
    }
    #shareDialog.open { display: flex; }
    .share-card {
      width: min(380px, calc(100vw - 32px));
      background: #FFFFFF; border-radius: 8px; padding: 24px;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.2);
      color: #444444; font-size: 14px;
    }
    .share-card h2 { margin: 0 0 6px; font-size: 18px; color: #333333; }
    .share-card p { margin: 0 0 10px; line-height: 1.45; }
    .share-note { font-size: 12px; color: #777777; }
    .share-email {
      font-size: 16px; font-weight: 600; color: #B5543A;
      user-select: all; /* un clic selecciona todo el correo */
      overflow-wrap: anywhere;
    }
    .share-card .btn-row { margin-top: 12px; }
    /* Editor de silueta: la foto en grande sobre las postales */
    #maskEditor {
      position: absolute; inset: 0; z-index: 15;
      display: none; align-items: center; justify-content: center;
      flex-direction: column; gap: 14px;
      background: rgba(243, 237, 220, 0.85);
    }
    #maskEditor.open { display: flex; animation: viewer-in 0.2s ease-out; }
    /* Resultado en grande, igual que el editor pero solo para mirar */
    #resultViewer {
      position: absolute; inset: 0; z-index: 15;
      display: none; align-items: center; justify-content: center;
      flex-direction: column; gap: 14px;
      background: rgba(243, 237, 220, 0.85);
      cursor: pointer;
    }
    #resultViewer.open { display: flex; animation: viewer-in 0.2s ease-out; }
    .save-only { width: min(220px, 60%); }
    #resultViewer img {
      max-width: 70%; max-height: 65%; object-fit: contain;
      border-radius: 4px; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.15);
    }
    #previewBox.has-photo, #canvasFrame { cursor: zoom-in; }
    #maskEditorCanvas {
      display: block; touch-action: none; /* sin scroll al pintar con el dedo */
      border-radius: 4px; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.15);
    }
    #maskEditorCanvas.can-paint { cursor: crosshair; }
    /* La foto del editor como postal que gira (frente = foto, reverso = poema) */
    #maskEditor .editor-card { cursor: default; }
    .editor-card .editor-front {
      position: relative;
      backface-visibility: hidden; -webkit-backface-visibility: hidden;
    }
    .editor-card.flipped .postcard-inner { transform: rotateY(180deg); }
    #maskEditor.done .editor-card { cursor: pointer; } /* en la etapa 3 se puede dar vuelta */
    /* Etapa 3: guardar solo con los datos completos */
    #maskEditor:not(.data-ok) .final-download { opacity: 0.55; } /* se ve, pero falta rellenar */
    /* Datos que faltan por rellenar: remarcados en terracota */
    #maskEditor.step3 .pc-missing {
      background: rgba(181, 84, 58, 0.09);
      border-bottom: 1.5px solid #B5543A;
      border-radius: 3px 3px 0 0;
      padding-left: 0.35em; padding-right: 0.35em;
      animation: pc-missing-glow 1.1s ease-in-out infinite;
    }
    #maskEditor.step3 .pc-missing .pc-label { color: #B5543A; }
    #maskEditor.step3 .pc-missing .pc-input::placeholder,
    #maskEditor.step3 .pc-missing .pc-date-text.empty { color: #C98A78; }
    #maskEditor.step3 .pc-author-row.pc-missing { padding-top: 0.3em; padding-bottom: 0.2em; }
    @keyframes pc-missing-glow {
      0%, 100% { background-color: rgba(181, 84, 58, 0.03); border-bottom-color: rgba(181, 84, 58, 0.35); }
      50% { background-color: rgba(181, 84, 58, 0.30); border-bottom-color: #B5543A; }
    }
    /* Tocaron "Descargar postal" sin rellenar todo: los que faltan tiemblan */
    #maskEditor.nudge .pc-missing { animation: pc-missing-shake 0.45s ease-in-out, pc-missing-glow 1.1s ease-in-out infinite 0.45s; }
    @keyframes pc-missing-shake {
      0%, 100% { transform: translateX(0); }
      25% { transform: translateX(-4px); }
      75% { transform: translateX(4px); }
    }
    .stamp {
      flex-shrink: 0; width: 66px; height: 82px; padding: 5px; /* mismo tamaño siempre */
      background: #FFFFFF;
      /* borde perforado: el centro queda entero y solo el marco lleva agujeros */
      -webkit-mask: linear-gradient(#000 0 0) content-box,
                    radial-gradient(circle 2.5px at 4px 4px, transparent 96%, #000) 0 0 / 8px 8px;
              mask: linear-gradient(#000 0 0) content-box,
                    radial-gradient(circle 2.5px at 4px 4px, transparent 96%, #000) 0 0 / 8px 8px;
      filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.15));
      cursor: grab; touch-action: none; user-select: none;
    }
    .stamp.dragging { opacity: 0.3; }
    .stamp-ghost { position: fixed; z-index: 50; pointer-events: none; transform: translate(-50%, -50%) rotate(-6deg); cursor: grabbing; }
    .stamp-inner {
      width: 100%; height: 100%; background: #B5543A; color: #F3EDDC;
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
      font-size: 7px; font-weight: 600; letter-spacing: 0.02em; line-height: 1.15;
      text-align: center; padding: 0 4px;
    }
    .stamp-inner svg { width: 55%; height: 42%; fill: none; stroke: currentColor; stroke-width: 3; stroke-linecap: round; }
    /* Sobre: sube desde abajo, recibe la postal y se cierra */
    .envelope {
      position: absolute; left: 50%; bottom: 7%;
      transform: translate(-50%, 140%);
      transition: transform 0.8s cubic-bezier(.2,.8,.2,1);
      pointer-events: none; perspective: 900px;
      visibility: hidden;
    }
    #maskEditor.env-up .envelope { transform: translate(-50%, 0); visibility: visible; }
    .env-back, .env-front, .env-flap { position: absolute; inset: 0; }
    .env-back { background-color: #D9C7A7; border-radius: 4px; box-shadow: 0 10px 30px rgba(0,0,0,0.18); }
    .env-front {
      background-color: #E7D8BC; border-radius: 0 0 4px 4px;
      clip-path: polygon(0 0, 50% 56%, 100% 0, 100% 100%, 0 100%); /* bolsillo: todo menos la "V" de arriba */
    }
    .env-flap {
      background-color: #CDB894;
      clip-path: polygon(0 0, 100% 0, 50% 56%);
      transform-origin: top center;
      transform: rotateX(180deg);                        /* abierta: apunta hacia arriba */
      transition: transform 0.7s ease-in-out;
    }
    /* Capas: fondo del sobre (2) < postal (3) < bolsillo y solapa cerrada (4).
       La solapa abierta va atrás; al cerrarse se usa la de adelante. */
    .env-layer-back { z-index: 2; }
    .env-layer-front { z-index: 4; }
    #maskEditor.sending .editor-card { position: relative; z-index: 3; }
    .flap-front { visibility: hidden; }
    #maskEditor.env-closing .flap-back { visibility: hidden; }
    #maskEditor.env-closing .flap-front { visibility: visible; transform: rotateX(0deg); }
    /* Dentro del sobre, sin sombra: así nada asoma bajo su borde */
    #maskEditor.env-up .editor-card .postcard-face { box-shadow: none; }
    /* Mientras se ensobra, desaparecen botones y textos */
    #maskEditor.sending .final-block,
    #maskEditor.sending .mask-editor-hint,
    #maskEditor.sending .mask-editor-tools { display: none !important; }
    /* Mensaje final, arriba del sobre */
    .sent-message {
      display: none; max-width: min(620px, 92%); text-align: center;
      color: #444444; font-size: 14px; line-height: 1.5;
      position: absolute; top: 12%; left: 50%; transform: translateX(-50%);
    }
    .sent-message p { margin: 0 0 10px; }
    .sent-message .sent-copy, .sent-message .sent-save { width: auto; display: inline-block; padding: 9px 22px; margin: 0 4px 12px; }
    /* Título del mensaje final, como el título de la página */
    .sent-message .sent-details { margin-top: 96px; } /* más abajo, separado del título */
    .sent-message .sent-question { margin: 0 0 14px; font-size: 40px; font-weight: 600; line-height: 1.15; color: #2FB5A8; white-space: nowrap; } /* siempre en dos líneas */ /* turquesa, como la estampilla del sobre */
    /* "Postales descargadas": estampilla turquesa que se pega en el sobre
       ya cerrado (mismo borde perforado que las otras) */
    .sent-stamp {
      position: absolute; left: 50%; top: 56%; z-index: 1; /* sobre la punta de la solapa */
      max-width: 80%; padding: 6px;
      background: #FFFFFF;
      opacity: 0; transform: translate(-50%, -50%) scale(1.6) rotate(-14deg);
      transition: opacity 0.25s ease-out, transform 0.45s cubic-bezier(.3,1.5,.5,1);
      -webkit-mask: linear-gradient(#000 0 0) content-box,
                    radial-gradient(circle 2.5px at 4px 4px, transparent 96%, #000) 0 0 / 8px 8px;
              mask: linear-gradient(#000 0 0) content-box,
                    radial-gradient(circle 2.5px at 4px 4px, transparent 96%, #000) 0 0 / 8px 8px;
      filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.15));
    }
    .sent-stamp-inner {
      background: #2FB5A8; color: #FFFFFF; /* turquesa, como la silueta */
      padding: 10px 18px; font-size: 16px; font-weight: 600; letter-spacing: 0.02em;
      text-align: center; line-height: 1.2;
    }
    #maskEditor.sent .sent-stamp { opacity: 1; transform: translate(-50%, -50%) scale(1) rotate(-4deg); }
    #maskEditor.sent .sent-message { display: block; animation: viewer-in 0.4s ease-out; }
    /* Reverso editable */
    .pc-top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: auto; gap: 0.6em; }
    .pc-top .pc-stamp { margin-bottom: 0; }
    .pc-top { justify-content: flex-end; }
    /* Fecha escrita con palabras; el calendario queda escondido detrás */
    .pc-date-line { position: relative; cursor: pointer; }
    .pc-date-text { color: #444444; }
    .pc-date-text.empty { color: #BBBBBB; }
    .pc-date-input {
      position: absolute; left: 0; bottom: 0; width: 1px; height: 1px;
      opacity: 0; pointer-events: none; border: 0; padding: 0;
    }
    /* Calendario propio (el del navegador no deja cambiar sus colores): café */
    .pc-calendar {
      position: fixed; z-index: 70; display: none; width: 264px;
      background: #FBF7F0; border: 1px solid #E6D9CC; border-radius: 8px;
      box-shadow: 0 10px 30px rgba(94, 68, 51, 0.22);
      padding: 12px; color: #5E4433; font-size: 13px; user-select: none;
    }
    .pc-calendar.open { display: block; }
    .cal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
    .cal-title { font-weight: 600; font-size: 14px; }
    .cal-nav {
      width: 30px; height: 30px; border: none; border-radius: 50%; background: none;
      color: #7B5B45; font-size: 18px; line-height: 1; cursor: pointer;
    }
    .cal-nav:hover { background: #E6D9CC; }
    .cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; text-align: center; }
    .cal-wd { font-size: 11px; font-weight: 600; color: #A08670; padding: 4px 0; }
    .cal-day {
      height: 32px; border: none; border-radius: 50%; background: none;
      font: inherit; color: #5E4433; cursor: pointer; padding: 0;
    }
    .cal-day:hover { background: #E6D9CC; }
    .cal-day.other { color: #C4B3A3; }
    .cal-day.today { box-shadow: inset 0 0 0 1px #7B5B45; }
    .cal-day.selected { background: #7B5B45; color: #FFFFFF; }
    .cal-foot { display: flex; justify-content: space-between; margin-top: 8px; }
    .cal-foot button {
      border: none; background: none; padding: 4px 6px; border-radius: 4px;
      font: inherit; font-weight: 600; color: #7B5B45; cursor: pointer;
    }
    .cal-foot button:hover { background: #E6D9CC; }
    /* Arriba, en la etapa 3 hasta completar los datos */
    .complete-prompt {
      display: none; font-size: 24px; font-weight: 600; line-height: 1.2; color: #B5543A; /* como el título de la página */
      text-align: center; max-width: min(560px, 90%);
    }
    #maskEditor.step3:not(.sending) .complete-prompt { display: block; }
    /* Pegada: la estampilla mantiene su tamaño, centrada en el recuadro */
    .pc-input {
      flex: 1; min-width: 0; border: none; background: transparent; outline: none;
      font: inherit; color: #444444; padding: 0;
    }
    .pc-input::placeholder { color: #BBBBBB; }
    .pc-author-row { display: flex; gap: 0.4em; align-items: baseline; }
    .pc-author-row .pc-input { color: #666666; }

    #maskEditor.done, #maskEditor.done #maskEditorCanvas { cursor: pointer; }
    .mask-editor-tools { width: min(560px, 90%); }
    .mask-editor-tools button { white-space: nowrap; }
    #maskChange { flex: 1.6; } /* el texto más largo, un poco más ancho */
    /* Guardar / Enviar: solo con el poema listo (y en el editor, al terminar la animación) */
    .final-block { width: min(420px, 90%); display: flex; flex-direction: column; gap: 8px; }
    .color-row .primary-btn { flex: 1; width: auto; }
    .final-block.confirmed .color-row { display: none; } /* tras "Listo" se reemplaza por guardar/enviar */
    .final-row, .final-block:not(.confirmed) .final-row.ready { display: none; }
    .final-row .primary-btn { flex: 1; width: auto; }
    .final-row.ready { display: flex; }
    #maskEditor:not(.done) .final-block { display: none; }
    #maskEditor.done .mask-editor-tools { display: none; } /* en su lugar van guardar/enviar */
    .mask-editor-tools .primary-btn { flex: 1; width: auto; }
    .mask-editor-hint { font-size: 12px; color: #7B5B45; } /* café */
    /* Visor: la postal tocada, en grande y centrada en el lado derecho */
    #postcardViewer {
      position: absolute; inset: 0; z-index: 10;
      display: none; align-items: center; justify-content: center;
      flex-direction: column; gap: 14px;
      background: rgba(243, 237, 220, 0.65);
      cursor: pointer;
    }
    #postcardViewer.open { display: flex; animation: viewer-in 0.2s ease-out; }
    @keyframes viewer-in { from { opacity: 0; } to { opacity: 1; } }
    #postcardHint { font-size: 12px; color: #7B5B45; } /* café */
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
      background-color: #F7F3EA; color: #444444; /* color hueso suave */
      display: flex; padding: calc(var(--h) * 0.08);
      gap: calc(var(--h) * 0.06);
      font-size: calc(var(--h) * 0.045);
    }
    .pc-message { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
    .pc-poem { font-size: 0.85em; line-height: 1.3; white-space: pre-line; } /* respeta los saltos de línea */
    .pc-author { margin-top: auto; padding-top: 1em; font-size: 0.7em; color: #888888; } /* siempre al fondo */
    .pc-divider { width: 1px; background: #CCCCCC; }
    .pc-address { flex: 1; min-width: 0; display: flex; flex-direction: column; font-size: 0.7em; } /* datos más pequeños que el poema */
    /* Sello (matasellos) arriba a la derecha: por ahora vacío, dos anillos */
    .pc-stamp {
      align-self: flex-end; position: relative; flex-shrink: 0;
      width: calc(var(--h) * 0.24); height: calc(var(--h) * 0.24);
      border: 1.5px solid #AAAAAA; border-radius: 50%;
      transform: rotate(-8deg);
      margin-bottom: auto;
    }
    .pc-stamp::after {
      content: ""; position: absolute; inset: 9%;
      border: 1px solid #AAAAAA; border-radius: 50%;
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
    .pc-value { min-width: 0; overflow-wrap: anywhere; } /* si no cabe, pasa a otra línea */
    /* Teléfono sin menú de compartir: fotos para guardar a mano */
    #saveSheet {
      position: fixed; inset: 0; z-index: 60; display: none;
      flex-direction: column; align-items: center; gap: 12px;
      background: #F3EDDC; overflow-y: auto; padding: 28px 16px 32px; text-align: center;
    }
    #saveSheet.open { display: flex; }
    .save-sheet-title { margin: 0; font-size: 20px; font-weight: 600; color: #B5543A; }
    .save-sheet-hint { margin: 0; font-size: 14px; line-height: 1.45; color: #555555; max-width: 360px; }
    .save-sheet-images { display: flex; flex-direction: column; gap: 14px; width: 100%; align-items: center; }
    .save-sheet-images img {
      display: block; max-width: 100%; height: auto; border-radius: 4px;
      box-shadow: 0 8px 30px rgba(0, 0, 0, 0.15);
      -webkit-touch-callout: default; /* deja el menú de mantener presionado en iPhone */
    }
    .save-sheet-close { width: min(260px, 100%); flex-shrink: 0; }

    /* Solo en el teléfono: barra de pasos y botón "Plasmar poema" */
    .mobile-only { display: none; }
    #stepNav {
      gap: 6px; margin: 0 -20px; padding: 10px 20px;
      border-top: 1px solid #E8D2CE;
    }
    .step-tab {
      flex: 1; min-width: 0; min-height: 40px;
      display: flex; align-items: center; justify-content: center; gap: 6px;
      background: transparent; border: 1px solid #E0C6C1; border-radius: 20px;
      font: inherit; font-size: 12.5px; font-weight: 600; color: #8C6F69;
      cursor: pointer; padding: 6px 4px;
    }
    .step-num {
      flex-shrink: 0; width: 20px; height: 20px; border-radius: 50%;
      display: inline-flex; align-items: center; justify-content: center;
      background: #EBD3CE; color: #8C6F69; font-size: 11px;
    }
    .step-tab.current { background: #B5543A; border-color: #B5543A; color: #FFFFFF; }
    .step-tab.current .step-num { background: #FFFFFF; color: #B5543A; }
    .step-tab:disabled { opacity: 0.4; cursor: not-allowed; }

    /* ---------- TELÉFONO (igual que MOBILE_QUERY) ----------
       El panel arriba a todo el ancho, las postales debajo, y la página
       hace scroll. Las vistas en grande cubren toda la pantalla. */
    @media (max-width: 700px), (max-height: 500px) and (orientation: landscape) {
      html, body { height: auto; overflow-x: hidden; overflow-y: auto; }
      body.viewer-open { overflow: hidden; } /* con algo abierto, no se mueve lo de atrás */
      /* Arriba una fila de postales chicas; abajo el panel, que llena el resto */
      #app { flex-direction: column; width: 100%; height: auto; min-height: 100vh; min-height: 100svh; }
      #below {
        order: -1; flex: none; height: 140px;
        background: #F3EDDC; /* hueso */
        border-bottom: 1px solid #E8D2CE;
      }
      .postcard.postcard-empty { background-color: #E2C16B; } /* postales vacías: amarillo mostaza suave */
      .postcard { font-size: 22px; } /* número de prueba, a la medida de la postal chica */
      #panel {
        flex: 1; width: 100%; min-width: 0; overflow: visible;
        border-right: none; padding-top: 8px;
      }
      #colTitle {
        order: -2; /* arriba de todo, antes de las postales */
        background: #F7E6E3; padding: 32px 20px 16px; /* aire arriba: baja el título y todo lo demás */
        border-bottom: 1px solid #E8D2CE;
      }
      #stepNav { border-top: none; }
      #title { font-size: 22px; }
      #subtitle { font-size: 12.5px; }
      #poemInput { font-size: 16px; height: 72px; } /* 16px: con menos el iPhone hace zoom al escribir. 3 renglones de 24px; si hay más, scroll */

      /* Una etapa a la vez: la barra de pasos elige cuál se ve */
      .mobile-only { display: flex; }
      .step-card { display: none; flex: 1 0 auto; justify-content: flex-start; padding-top: 20px; padding-bottom: 28px; }
      #panel[data-step="1"] #colPhoto,
      #panel[data-step="2"] #colPoem,
      #panel[data-step="3"] #colResult { display: flex; }
      .step-card.active { background: transparent; } /* ya se distingue por estar sola */
      .step-card .field-label { color: #B5543A; text-align: center; }
      /* sin títulos de sección: la barra de pasos ya dice en qué paso vas */
      .step-card .field-label { display: none; }
      #poemPlasmar {
        width: min(260px, 100%); align-self: center; margin-top: 6px;
        align-items: center; justify-content: center; /* texto centrado (es flex por .mobile-only) */
      }

      #resultViewer, #postcardViewer { position: fixed; }
      /* fondo hueso entero: en el teléfono atrás está el panel, no las postales */
      #resultViewer, #postcardViewer { background: #F3EDDC; }
      /* El editor va dentro del panel, bajo la barra de pasos (ver placeMaskEditor) */
      #maskEditor {
        position: relative; inset: auto; z-index: auto;
        background: transparent; gap: 12px;
        margin: 0 -20px; padding: 18px 0 28px;
      }
      #maskEditor #poemBox { width: calc(100% - 50px) !important; margin: 10px auto 4px; } /* renglones bajo la foto */
      #maskEditor.sending { min-height: 560px; justify-content: flex-start; } /* lugar para el sobre y el mensaje */

      /* Botones: a todo el ancho y más fáciles de tocar */
      .mask-editor-tools, .final-block, .save-only { width: calc(100% - 32px); }
      .mask-editor-tools { flex-wrap: wrap; }
      #maskChange { flex: 1 1 100%; }
      .primary-btn, .toggle-btn { min-height: 42px; font-size: 13px; }
      .mask-editor-hint, #postcardHint { padding: 0 16px; text-align: center; }

      .complete-prompt { padding: 0 16px; max-width: 100%; font-size: 19px; }
      .sent-message { width: calc(100% - 32px); top: 6%; }
      .sent-message .sent-question { font-size: min(28px, 6.4vw); } /* las dos líneas caben en el teléfono */
      #resultViewer img { max-width: 92%; max-height: 70%; }
    }
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

  createElement("h1", "Ahora cada espacio<br>de mí es un poema")
    .id("title")
    .parent(colTitle);
  createP("Una experiencia web interactiva para cubrirte y plasmarte en un poema. Subes tu autorretrato, escribes tus palabras y estas se distribuyen dentro de tu silueta.")
    .id("subtitle")
    .parent(colTitle);

  // Solo en el teléfono: los tres pasos, para ver una etapa a la vez
  const stepNav = createDiv().id("stepNav").addClass("btn-row mobile-only").parent(panel);
  ["Retrato", "Poema", "Postal"].forEach((label, i) => {
    const tab = document.createElement("button");
    tab.className = "step-tab";
    tab.dataset.step = i + 1;
    tab.innerHTML = `<span class="step-num">${i + 1}</span><span>${label}</span>`;
    tab.addEventListener("click", () => goToStep(i + 1));
    stepNav.elt.appendChild(tab);
  });


  // Sección 2: subir foto + vista previa
  const colPhoto = createDiv().id("colPhoto").addClass("col step-card").parent(panel);

  // Input de archivo escondido; se activa al tocar el recuadro de la vista previa
  fileInputEl = createFileInput(handleFileSelected);
  fileInputEl.hide();
  fileInputEl.parent(colPhoto);

  // Vista previa: la foto con la zona detectada como retrato marcada.
  // El mismo recuadro sirve para subir (o cambiar) el autorretrato.
  createDiv('<span class="step-num">1</span>Retrato').addClass("field-label").parent(colPhoto);
  const previewSlot = createDiv().id("previewSlot").parent(colPhoto);
  const previewBox = createDiv().id("previewBox").parent(previewSlot);
  previewBox.attribute("role", "button");
  previewBox.attribute("tabindex", "0");
  previewBox.attribute("aria-label", "Agregar autorretrato");
  // Sin foto: tocarlo sube una. Con foto: la abre en grande para editar la silueta
  const onPreviewTap = () => (photoReady ? openMaskEditor() : pickPhoto());
  previewBox.elt.addEventListener("click", onPreviewTap);
  previewBox.elt.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPreviewTap(); }
  });
  previewCanvasEl = document.createElement("canvas");
  previewBox.elt.appendChild(previewCanvasEl);
  // Ícono de retrato (cabeza, cuello y hombros) mientras no hay foto
  createDiv(`<svg viewBox="0 0 64 64" aria-hidden="true">
      <circle cx="32" cy="19" r="10"/>
      <path d="M27.5 28v6.5c-9 1.5-15.5 9-15.5 21.5"/>
      <path d="M36.5 28v6.5c9 1.5 15.5 9 15.5 21.5"/>
    </svg>`).id("uploadLabel").parent(previewBox);
  ["tl", "tr", "bl", "br"].forEach((pos) => {
    createDiv().addClass("corner corner-" + pos).parent(previewBox);
  });

  // La foto se agrega tocando el recuadro; para cambiarla, está el botón bajo la foto en grande

  // Sección 3: poema + color de la letra
  const colPoem = createDiv().id("colPoem").addClass("col step-card").parent(panel);

  createDiv('<span class="step-num">2</span>Poema').addClass("field-label").parent(colPoem);

  // Los renglones van dentro de un cuadro hueso con esquinas, como los otros
  const poemBox = createDiv().id("poemBox").parent(colPoem);
  poemTextarea = createElement("textarea", "");
  poemTextarea.id("poemInput");
  poemTextarea.attribute("rows", "4");
  poemTextarea.attribute("placeholder", "Escribe aquí tu poema"); // se borra solo al empezar a escribir
  poemTextarea.parent(poemBox);
  poemTextarea.input(() => { schedulePoemRender(); updateStepUI(); });
  poemTextarea.elt.addEventListener("focus", updateStepUI);
  poemTextarea.elt.addEventListener("blur", updateStepUI);
  ["tl", "tr", "bl", "br"].forEach((pos) => {
    createDiv().addClass("corner corner-" + pos).parent(poemBox);
  });
  // "Letra blanca / Letra negra" ya no van aquí: están bajo la foto en grande
  // Tocar el cuadro del poema vuelve a mostrar cómo se escribe, en grande.
  // En el teléfono no: la foto en grande taparía el teclado. Ahí está el
  // botón "Plasmar poema", para cuando termines de escribir.
  poemBox.elt.addEventListener("click", () => { if (!isMobile()) replayPoemAnimation(); });
  const plasmarBtn = createButton("Plasmar poema").id("poemPlasmar").addClass("primary-btn mobile-only").parent(colPoem);
  plasmarBtn.elt.addEventListener("click", () => {
    poemTextarea.elt.blur(); // cierra el teclado
    replayPoemAnimation();
  });

  // Sección 4: resultado final (se genera solo) + guardar
  const colResult = createDiv().id("colResult").addClass("col step-card").parent(panel);

  createDiv('<span class="step-num">3</span>Postal').addClass("field-label").parent(colResult);

  // Zona donde se muestra el resultado final
  const stage = createDiv().id("stage").parent(colResult);
  const canvasFrame = createDiv().id("canvasFrame").parent(stage);
  canvasFrameEl = canvasFrame;
  // Tocar el resultado lo muestra en grande (como las postales)
  canvasFrame.attribute("role", "button");
  canvasFrame.attribute("tabindex", "0");
  canvasFrame.attribute("aria-label", "Ver resultado en grande");
  canvasFrame.elt.addEventListener("click", openResultViewer);
  canvasFrame.elt.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openResultViewer(); }
  });

  cnv = createCanvas(480, 320); // provisional, con forma de postal; se ajusta al subir la foto
  cnv.parent(canvasFrame);

  // Marcas decorativas en las esquinas
  ["tl", "tr", "bl", "br"].forEach((pos) => {
    createDiv().addClass("corner corner-" + pos).parent(canvasFrame);
  });

  // "Guardar imagen" y "Enviar mi postal" ya no van aquí: aparecen bajo la
  // foto en grande cuando el poema terminó de escribirse (ver makeFinalRow)

  // Lado derecho: las postales (se crean y mueven en buildPostcards)
  createDiv().id("below").parent(appDiv);

  placeTitle();
  layoutBoxes(); // ahora que todo está armado, se puede medir
  updateStepUI();
}

// ---------------------------------------------------------------------
// FOTO, POEMA Y BOTONES
// ---------------------------------------------------------------------
// Aviso bajo el recuadro de la foto cuando no se puede abrir
function showPhotoError(msg) {
  let el = document.getElementById("photoError");
  if (!el) {
    el = document.createElement("div");
    el.id = "photoError";
    document.getElementById("previewSlot").after(el);
  }
  el.textContent = msg;
  clearTimeout(showPhotoError.timer);
  showPhotoError.timer = setTimeout(() => el.remove(), 9000);
}

function handleFileSelected(file) {
  const name = (file.name || "").toLowerCase();
  const isHeic = /\.(heic|heif)$/.test(name) || /heic|heif/.test(file.subtype || "");
  if (isHeic) {
    showPhotoError("Esta foto es HEIC (formato del iPhone) y el navegador no puede abrirla. " +
      "Expórtala como JPG (en Fotos: Archivo › Exportar) o en el iPhone usa Ajustes › Cámara › Formatos › Más compatible.");
    return;
  }
  if (file.type !== "image") {
    showPhotoError("El archivo elegido no es una imagen. Prueba con una foto JPG o PNG.");
    return;
  }

  const failed = () => showPhotoError("No se pudo abrir esta foto. Prueba con otra en JPG o PNG.");
  loadImage(file.data, (img) => {
    if (!img || !img.width) { failed(); return; }
    const err = document.getElementById("photoError");
    if (err) err.remove();
    originalImg = fitImageToMax(cropIfTooTall(img), CONFIG.maxCanvasSize);
    resizeCanvas(originalImg.width, originalImg.height);
    layoutBoxes();

    photoReady = true;
    maskReady = false;
    silhouetteDone = false; // foto nueva: se vuelve a partir por la silueta
    letterDone = false;
    maskImg = null;
    closeResultViewer();
    photoId++;
    appState = "vacio"; // ya hay foto, falta generar el retrato
    renderId++;         // descarta cualquier dibujo de la foto anterior
    clearPoemLayer();

    refreshSaveButton();
    redraw();
    drawPreview();
    openMaskEditor(); // la foto se abre en grande mientras se traza la silueta
    if (modelReady) detectPerson();
  }, failed);
}

// Abre la ventana para elegir foto (se limpia antes, para poder elegir
// la misma foto otra vez si se quiere)
function pickPhoto() {
  fileInputEl.elt.value = "";
  fileInputEl.elt.click();
}

// Detecta a la persona en la foto actual y arma la máscara. Se hace
// apenas se sube la foto, para mostrarla en la vista previa.
function detectPerson() {
  const myPhotoId = photoId;

  bodyPixModel.segment(originalImg, (err, result) => {
    if (myPhotoId !== photoId) return; // subieron otra foto mientras tanto
    if (err) {
      console.error(err);
      return;
    }

    buildMask(result, () => {
      if (myPhotoId !== photoId) return;
      maskReady = true;
        drawPreview();
      if (maskEditorOpen && editorPhase === "edit") { updateMaskEditorUI(); sizeMaskEditor(); }
      renderPoem(); // si ya había poema, se plasma de inmediato
    });
  });
}

// Dibuja la foto en un canvas (sin deformarla) y, si ya se detectó, marca
// en turquesa la zona considerada retrato. Devuelve dónde quedó la foto.
function drawPhotoWithMask(canvasEl) {
  const boxW = canvasEl.clientWidth;
  const boxH = canvasEl.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  canvasEl.width = Math.round(boxW * dpr);
  canvasEl.height = Math.round(boxH * dpr);

  const ctx = canvasEl.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, boxW, boxH);
  if (!photoReady) return null;

  const imgW = originalImg.width;
  const imgH = originalImg.height;
  const scale = Math.min(boxW / imgW, boxH / imgH);
  const drawW = imgW * scale;
  const drawH = imgH * scale;
  const x = (boxW - drawW) / 2;
  const y = (boxH - drawH) / 2;

  ctx.drawImage(originalImg.canvas, x, y, drawW, drawH);

  if (maskReady && maskImg) {
    // Pinta de turquesa solo donde la máscara dice "persona"
    const tint = document.createElement("canvas");
    tint.width = imgW;
    tint.height = imgH;
    const tctx = tint.getContext("2d");
    tctx.drawImage(maskImg.canvas, 0, 0);
    tctx.globalCompositeOperation = "source-in";
    tctx.fillStyle = "#2FB5A8"; // turquesa
    tctx.fillRect(0, 0, imgW, imgH);

    ctx.globalAlpha = 0.5;
    ctx.drawImage(tint, x, y, drawW, drawH);
    ctx.globalAlpha = 1;
  }
  return { x, y, scale };
}

// Vista previa del panel izquierdo
function drawPreview() {
  if (!previewCanvasEl) return;
  // Con foto, se esconde el texto del recuadro y el botón pasa a "Cambiar autorretrato"
  previewCanvasEl.parentElement.classList.toggle("has-photo", photoReady);
  previewCanvasEl.parentElement.setAttribute("aria-label", photoReady ? "Editar silueta" : "Agregar autorretrato");
  drawPhotoWithMask(previewCanvasEl);
}

// ---------------------------------------------------------------------
// EDITOR DE SILUETA (la foto en grande, como las postales)
// 1) Apenas se agrega una foto se abre aquí y se traza la silueta.
// 2) Se puede pintar (agrega zona turquesa, donde irá el poema) o
//    borrar (la quita). Se dibuja directo sobre la máscara.
// 3) Con "Listo" se ve cómo salen las líneas de la grilla, de izquierda
//    a derecha, y luego cómo se escribe el poema sobre ellas.
// ---------------------------------------------------------------------
const BRUSH_SIZE = 28;          // diámetro del pincel en pantalla (px)
const GRID_ANIM_MS = 1600;      // cuánto tarda en trazarse la grilla
const POEM_ANIM_MS = 2600;      // cuánto tarda en escribirse el poema
let editorPhase = "edit";       // "edit" (pintar/borrar), "anim" (animación) o "done" (terminado)
let editorAnimId = 0;           // cambia al cerrar, para cortar animaciones viejas
let maskEditorDoneBtn, maskEditorHintEl, maskEditorToolsEl, maskEditorFinalEl;

function setBrushMode(mode) {
  brushMode = mode;
  if (!maskEditorPaintBtn) return;
  maskEditorPaintBtn.classList.toggle("toggle-btn-active", mode === "paint");
  maskEditorEraseBtn.classList.toggle("toggle-btn-active", mode === "erase");
}

// Arma la ventana del editor (una sola vez), encima de las postales
function buildMaskEditor() {
  maskEditorEl = document.createElement("div");
  maskEditorEl.id = "maskEditor";
  // La foto es el frente de una postal; en la etapa 3 gira y muestra el reverso
  maskEditorEl.innerHTML = `
    <div class="complete-prompt">¡Rellena tus datos!</div>
    <div class="postcard-large editor-card">
      <div class="postcard-inner">
        <div class="editor-front"><canvas id="maskEditorCanvas"></canvas></div>
        <div class="postcard-face postcard-back" id="editorBack"></div>
      </div>
    </div>
    <div class="btn-row mask-editor-tools">
      <button class="toggle-btn" id="maskChange">Cambiar autorretrato</button>
      <button class="toggle-btn" id="maskPaint">Pintar</button>
      <button class="toggle-btn" id="maskErase">Borrar</button>
      <button class="primary-btn" id="maskDone">Listo</button>
    </div>
    <div class="mask-editor-hint"></div>
    <div class="envelope env-layer-back" aria-hidden="true">
      <div class="env-back"></div>
      <div class="env-flap flap-back"></div>
    </div>
    <div class="envelope env-layer-front" aria-hidden="true">
      <div class="env-front"></div>
      <div class="env-flap flap-front"></div>
      <div class="sent-stamp"><div class="sent-stamp-inner">Postales<br>descargadas</div></div>
    </div>
    <div class="sent-message">
      <p class="sent-question">¿Quieres que tu postal<br>forme parte de esta web?</p>
      <div class="sent-details">
        <p>Envíala a este correo (la <strong>portada</strong> y la <strong>contraportada</strong>):</p>
        <p class="share-email">${SHARE_EMAIL}</p>
        <button class="primary-btn sent-save">Guardar otra vez</button>
        <button class="primary-btn sent-copy">Copiar correo</button>
        <p class="share-note"></p>
      </div>
    </div>`;
  placeMaskEditor();

  maskEditorCanvasEl = maskEditorEl.querySelector("#maskEditorCanvas");
  editorCardEl = maskEditorEl.querySelector(".editor-card");
  editorBackEls = buildEditorBack(maskEditorEl.querySelector("#editorBack"));
  // "Copiar correo" del mensaje final
  // "Guardar en mis fotos" (solo en el teléfono, ver playEnvelope)
  maskEditorEl.querySelector(".sent-save").addEventListener("click", saveBothSides);
  const sentCopy = maskEditorEl.querySelector(".sent-copy");
  sentCopy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(SHARE_EMAIL); sentCopy.textContent = "¡Copiado!"; }
    catch (err) { sentCopy.textContent = "No se pudo copiar"; }
    setTimeout(() => { sentCopy.textContent = "Copiar correo"; }, 2000);
  });
  maskEditorPaintBtn = maskEditorEl.querySelector("#maskPaint");
  maskEditorEraseBtn = maskEditorEl.querySelector("#maskErase");
  maskEditorEl.querySelector("#maskChange").addEventListener("click", () => pickPhoto());
  maskEditorDoneBtn = maskEditorEl.querySelector("#maskDone");
  maskEditorHintEl = maskEditorEl.querySelector(".mask-editor-hint");
  maskEditorToolsEl = maskEditorEl.querySelector(".mask-editor-tools");
  maskEditorFinalEl = makeFinalRow(maskEditorEl, () => {
    letterDone = true; // ya se puede ir a la Postal
    maskEditorHintEl.textContent = editorHint();
    updateStepUI();
    fillEditorBack();
    editorCardEl.classList.add("flipped"); // etapa 3: la postal se da vuelta para escribir los datos
    updateEditorDataUI();
  });
  maskEditorEl.insertBefore(maskEditorFinalEl, maskEditorHintEl); // bajo la foto, antes del texto de ayuda
  maskEditorPaintBtn.addEventListener("click", () => setBrushMode("paint"));
  maskEditorEraseBtn.addEventListener("click", () => setBrushMode("erase"));
  maskEditorDoneBtn.addEventListener("click", startPoemAnimation);
  // Tocar fuera de la foto o apretar Esc cierra (y al terminar, tocar en cualquier parte)
  maskEditorEl.addEventListener("click", (e) => {
    if (e.target.closest("button")) return; // los botones no cierran
    if (e.target.closest("#poemBox")) return; // escribir el poema (en el teléfono, sobre la foto) tampoco
    if (maskEditorEl.classList.contains("sending")) {
      // mientras se ensobra no se cierra; ya enviada, solo tocar fuera del mensaje cierra
      if (maskEditorEl.classList.contains("sent") && !e.target.closest(".sent-message")) closeMaskEditor();
      return;
    }
    // En la etapa 3, tocar la postal la da vuelta (tocar fuera la cierra);
    // escribir en los datos no la da vuelta
    if (isEditorStep3() && e.target.closest(".editor-card")) {
      if (e.target.closest("input, label, .pc-stamp")) return;
      editorCardEl.classList.toggle("flipped");
      return;
    }
    if (e.target === maskEditorEl || editorPhase === "done") closeMaskEditor();
  });
  document.addEventListener("keydown", (e) => {
    // Con el calendario abierto, Esc solo cierra el calendario
    if (calendarEl && calendarEl.classList.contains("open")) return;
    if (e.key === "Escape" && maskEditorOpen) closeMaskEditor();
  });
  setupMaskBrush();
}

// Botones y texto de ayuda según la etapa
function updateMaskEditorUI() {
  updateStepUI();
  if (!maskEditorEl) return;
  const editing = editorPhase === "edit";
  maskEditorToolsEl.style.visibility = editing ? "visible" : "hidden";
  const canEdit = editing && maskReady && !!maskImg;
  maskEditorPaintBtn.disabled = !canEdit;
  maskEditorEraseBtn.disabled = !canEdit;
  maskEditorDoneBtn.disabled = !canEdit;
  maskEditorCanvasEl.classList.toggle("can-paint", canEdit);
  if (editing) {
    maskEditorHintEl.textContent = canEdit
      ? "Lo turquesa es tu silueta: ahí se escribirá el poema. Pinta o borra para ajustarla."
      : "Trazando tu silueta…";
  }
}

// Se abre apenas se agrega la foto (y también al tocar la foto del panel)
function openMaskEditor() {
  if (!photoReady) return;
  if (!maskEditorEl) buildMaskEditor();
  editorAnimId++;
  editorPhase = "edit";
  maskEditorOpen = true;
  placeMaskEditor();
  setBrushMode("paint");
  maskEditorEl.classList.add("open");
  maskEditorEl.classList.remove("done");
  maskEditorFinalEl.classList.remove("confirmed"); // se vuelve a elegir la letra
  editorCardEl.classList.remove("flipped");        // siempre parte mostrando la foto
  resetEnvelope();
  updateEditorDataUI();
  updateMaskEditorUI();
  updateScrollLock();
  sizeMaskEditor();
}

function closeMaskEditor() {
  if (!maskEditorOpen) return;
  closeCalendar();
  editorAnimId++; // corta la animación si estaba en curso
  maskEditorOpen = false;
  maskEditorEl.classList.remove("open");
  updateScrollLock();
  updateStepUI();
  // En el teléfono, al cerrar la foto en grande se pasa a la etapa más
  // avanzada que esté habilitada (silueta, poema o postal)
  setMobileStep(3);
  drawPreview();
}

// En el computador el editor va sobre las postales (lado derecho); en el
// teléfono va dentro del panel, bajo la barra de pasos, en lugar de la
// etapa, así arriba siguen el título, las postales y los pasos
function placeMaskEditor() {
  if (!maskEditorEl) return;
  if (isMobile()) {
    const nav = document.getElementById("stepNav");
    if (maskEditorEl.previousElementSibling !== nav) nav.after(maskEditorEl);
  } else {
    const below = document.getElementById("below");
    if (maskEditorEl.parentElement !== below) below.appendChild(maskEditorEl);
  }
}

// La foto ocupa lo más posible del lado derecho, sin deformarse
function sizeMaskEditor() {
  if (!maskEditorOpen || !photoReady) return;
  let maxW, maxH;
  if (isMobile()) {
    // Todo el ancho del panel; de alto, lo justo para que quepan los botones
    const panelEl = document.getElementById("panel");
    maxW = panelEl.clientWidth - 32;
    maxH = window.innerHeight * 0.42;
  } else {
    const area = viewerArea();
    maxW = area.w * 0.7;
    maxH = area.h * 0.62; // deja lugar para títulos y botones
  }
  const ratio = originalImg.width / originalImg.height;
  const w = Math.floor(Math.min(maxW, maxH * ratio));
  const h = Math.floor(w / ratio);
  maskEditorCanvasEl.style.width = w + "px";
  maskEditorCanvasEl.style.height = h + "px";
  // Las letras del reverso escalan como en una postal 3:2 de este ancho
  editorCardEl.style.setProperty("--h", backTextHeight(w, h) + "px");
  if (editorBackEls) fitPoemText(editorBackEls.poem);
  if (editorPhase === "edit") {
    maskEditorFit = drawPhotoWithMask(maskEditorCanvasEl);
  } else {
    drawEditorFrame(lastAnimState.grid, lastAnimState.poem); // redibuja la animación al nuevo tamaño
  }
}

// ---- Animación: grilla y poema ----

// Los tramos de cuerpo de cada fila (los mismos que usa el poema)
function computeGridSegments() {
  maskImg.loadPixels();
  const w = maskImg.width;
  const h = maskImg.height;
  const scale = Math.max(w, h) / CONFIG.referenceSize;
  const out = [];
  for (const yy of poemRows(h, scale)) {
    const segs = scanRowSegments(maskImg, yy, CONFIG.cellCoverageThreshold,
      CONFIG.minSegmentWidth * scale, CONFIG.maxRowGap * scale, CONFIG.edgeMargin * scale);
    for (const [x0, x1] of segs) out.push({ y: yy, x0, x1 });
  }
  return out;
}

let animSegments = [];   // líneas de la grilla
let animLines = [];      // líneas del poema (texto + posición)
let lastAnimState = { grid: 0, poem: 0 };
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

// Dibuja un cuadro de la animación. grid y poem van de 0 a 1.
// Cada fila empieza un poquito después que la de arriba.
function drawEditorFrame(grid, poem) {
  lastAnimState = { grid, poem };
  const canvasEl = maskEditorCanvasEl;
  const boxW = canvasEl.clientWidth;
  const boxH = canvasEl.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  if (canvasEl.width !== Math.round(boxW * dpr)) canvasEl.width = Math.round(boxW * dpr);
  if (canvasEl.height !== Math.round(boxH * dpr)) canvasEl.height = Math.round(boxH * dpr);
  const ctx = canvasEl.getContext("2d");
  const s = Math.min(boxW / originalImg.width, boxH / originalImg.height);
  const ox = (boxW - originalImg.width * s) / 2;
  const oy = (boxH - originalImg.height * s) / 2;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, boxW, boxH);
  // A partir de aquí se dibuja en coordenadas de la foto
  ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
  ctx.drawImage(originalImg.canvas, 0, 0);

  const H = originalImg.height;
  const stagger = 0.5; // qué parte del tiempo se reparte entre filas
  const rowProgress = (t, y) => {
    const start = (y / H) * stagger;
    return easeOut(Math.max(0, Math.min(1, (t - start) / (1 - stagger))));
  };

  // Grilla: líneas blancas que crecen de izquierda a derecha. Cuando se
  // escribe el poema, cada línea se va borrando justo donde aparece el
  // texto, hasta desaparecer. Las que no llevan texto se desvanecen.
  const fontSizeImg = CONFIG.fontSize * Math.max(originalImg.width, H) / CONFIG.referenceSize;
  const writtenRows = new Set(animLines.map((l) => l.y + ":" + l.x0));
  ctx.lineWidth = Math.max(1, 1.5 / s);
  ctx.lineCap = "round";
  for (const seg of animSegments) {
    const g = rowProgress(grid, seg.y);
    if (g <= 0) continue;
    let from = seg.x0;
    let alpha = 0.9;
    if (poem > 0) {
      const p = rowProgress(poem, seg.y);
      if (writtenRows.has(seg.y + ":" + seg.x0)) {
        // mismo borde que usa el texto al aparecer
        from = seg.x0 - fontSizeImg + (seg.x1 - seg.x0 + 2 * fontSizeImg) * p;
      } else {
        alpha = 0.9 * (1 - p);
      }
    }
    const to = seg.x0 + (seg.x1 - seg.x0) * g;
    if (to <= from || alpha <= 0) continue;
    ctx.strokeStyle = "rgba(255, 255, 255, " + alpha + ")";
    ctx.beginPath();
    ctx.moveTo(Math.max(from, seg.x0), seg.y);
    ctx.lineTo(to, seg.y);
    ctx.stroke();
  }

  // Poema: cada línea se va escribiendo de izquierda a derecha
  if (poem > 0 && animLines.length) {
    const scale = Math.max(originalImg.width, H) / CONFIG.referenceSize;
    const fontSize = CONFIG.fontSize * scale;
    ctx.font = "bold " + fontSize + 'px "' + CONFIG.fontFamily + '"'; // la misma letra con que se midió el poema
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const white = CONFIG.textColor.every((c) => c === 255);
    const shadow = white ? SHADOW_COLOR.blanca : SHADOW_COLOR.negra;
    const [r, g, b] = CONFIG.textColor;
    for (const line of animLines) {
      const p = rowProgress(poem, line.y);
      if (p <= 0) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(line.x0 - fontSize, line.y - fontSize, (line.x1 - line.x0 + 2 * fontSize) * p, fontSize * 2);
      ctx.clip();
      if (CONFIG.textOutline) {
        ctx.fillStyle = "rgba(" + shadow.join(",") + "," + (160 / 255) + ")";
        ctx.fillText(line.text, line.cx + 1, line.y + 1);
      }
      ctx.fillStyle = "rgba(" + r + "," + g + "," + b + "," + (CONFIG.textAlpha / 255) + ")";
      ctx.fillText(line.text, line.cx, line.y);
      ctx.restore();
    }
  }
}

// Anima un valor de 0 a 1 en "ms" milisegundos, llamando a onFrame en cada cuadro
function animateValue(ms, myId, onFrame, onDone) {
  const t0 = performance.now();
  function step(now) {
    if (myId !== editorAnimId) return; // se cerró o empezó otra
    const t = Math.min(1, (now - t0) / ms);
    onFrame(t);
    if (t < 1) requestAnimationFrame(step);
    else onDone();
  }
  requestAnimationFrame(step);
}

// "Listo": se trazan las líneas y luego se escribe el poema
function startPoemAnimation() {
  if (!maskReady || !maskImg || editorPhase !== "edit") return;
  const myId = ++editorAnimId;
  editorPhase = "anim";
  silhouetteDone = true; // ya se puede ir al Poema
  updateMaskEditorUI();
  maskEditorHintEl.textContent = "Trazando las líneas…";
  animSegments = computeGridSegments();
  animLines = [];
  renderPoem(); // arma el poema con la silueta final (mientras se trazan las líneas)

  animateValue(GRID_ANIM_MS, myId, (t) => drawEditorFrame(t, 0), () => {
    const hasPoem = poemTextarea.value().trim().length > 0;
    if (!hasPoem) {
      finishAnimation(noPoemHint());
      return;
    }
    // Espera a que el poema esté armado (suele estar listo antes que la grilla)
    const waitPoem = () => {
      if (myId !== editorAnimId) return;
      if (appState !== "listo") { setTimeout(waitPoem, 60); return; }
      animLines = lastPoemLines;
      maskEditorHintEl.textContent = "Escribiendo tu poema…";
      animateValue(POEM_ANIM_MS, myId, (t) => drawEditorFrame(1, t), () => {
        finishAnimation(editorHint());
      });
    };
    waitPoem();
  });
}

// Fila con "Guardar imagen" y "Enviar mi postal". Se muestra solo cuando
// el retrato con poema está listo.
// Primero se elige "Letra blanca / Letra negra" y se toca "Listo"; recién
// entonces aparecen "Guardar imagen" y "Enviar mi postal".
function makeFinalRow(parent, onConfirm) {
  const block = document.createElement("div");
  block.className = "final-block";
  block.innerHTML = `
    <div class="btn-row color-row">
      <button class="toggle-btn final-white">Letra blanca</button>
      <button class="toggle-btn final-black">Letra negra</button>
      <button class="primary-btn final-confirm">Listo</button>
    </div>
    <div class="btn-row final-row">
      <button class="primary-btn final-download">Descargar postal</button>
    </div>`;
  const white = block.querySelector(".final-white");
  const black = block.querySelector(".final-black");
  white.addEventListener("click", () => setTextColor([255, 255, 255]));
  black.addEventListener("click", () => setTextColor([0, 0, 0]));
  colorButtonPairs.push([white, black]);
  updateColorButtonsUI();
  block.querySelector(".final-confirm").addEventListener("click", () => {
    block.classList.add("confirmed");
    if (onConfirm) onConfirm();
  });
  block.querySelector(".final-download").addEventListener("click", downloadPostcard);
  parent.appendChild(block);
  const row = block.querySelector(".final-row");
  finalRows.push(row);
  row.classList.toggle("ready", appState === "listo");
  return block;
}

// Si la foto está abierta en grande (ya terminada la animación), lo que se
// escribe en los renglones aparece ahí al tiro, sin volver a animar
// Texto de ayuda bajo la foto, cuando ya terminó la animación
// Cuando todavía no hay poema (en el teléfono el panel no se ve detrás)
function noPoemHint() {
  return isMobile()
    ? "Escribe o pega tu poema bajo la foto: aparecerá sobre estas líneas."
    : "Escribe tu poema en el panel y aparecerá sobre estas líneas. Toca para cerrar.";
}

function editorHint() {
  if (!lastPoemLines.length) return noPoemHint();
  if (!maskEditorFinalEl.classList.contains("confirmed")) return "Elige letra blanca o negra y toca Listo.";
  if (!editorDataComplete()) return ""; // arriba dice "Completa tus datos…"
  return "Toca la postal para darla vuelta. Toca fuera para cerrar.";
}

// ---- Etapa 3: la postal se da vuelta y se escriben los datos ----
let editorCardEl, editorBackEls;

function isEditorStep3() {
  return maskEditorOpen && editorPhase === "done" &&
    maskEditorFinalEl && maskEditorFinalEl.classList.contains("confirmed");
}

// Estampilla: marco perforado blanco, centro terracota con un retrato
const STAMP_HTML = `<div class="stamp-inner">
    <svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="19" r="10"/>
      <path d="M27.5 28v6.5c-9 1.5-15.5 9-15.5 21.5"/><path d="M36.5 28v6.5c9 1.5 15.5 9 15.5 21.5"/></svg>
    <span>cada espacio de mí es un poema</span>
  </div>`;

// Estación según la fecha (hemisferio sur, como en Chile)
function seasonFor(date) {
  const m = date.getMonth() + 1, d = date.getDate();
  const md = m * 100 + d;
  if (md >= 1221 || md < 321) return "verano";
  if (md < 621) return "otoño";
  if (md < 923) return "invierno";
  return "primavera";
}

// "2026-08-22" -> "Sábado 22 de agosto, invierno 2026"
function formatPostcardDate(isoValue) {
  if (!isoValue) return "";
  const [y, m, d] = isoValue.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const weekday = date.toLocaleDateString("es-CL", { weekday: "long" });
  const month = date.toLocaleDateString("es-CL", { month: "long" });
  return weekday.charAt(0).toUpperCase() + weekday.slice(1) + " " + d + " de " + month + ", " + seasonFor(date) + " " + y;
}

// Reverso para escribir: a la izquierda el poema y "Poema por", a la
// derecha "Escribe tus datos", la estampilla y De / Desde / Fecha
function buildEditorBack(backEl) {
  backEl.innerHTML = `
    <div class="pc-message">
      <div class="pc-poem"></div>
      <label class="pc-author pc-author-row">Poema por:
        <input class="pc-input" id="backAuthor" maxlength="60" placeholder="autora o autor del poema"></label>
    </div>
    <div class="pc-divider"></div>
    <div class="pc-address">
      <div class="pc-top">
        <div class="pc-stamp" id="editorStampBox"></div>
      </div>
      <label class="pc-line"><span class="pc-label">De</span>
        <input class="pc-input" id="backName" maxlength="60" placeholder="tu nombre"></label>
      <label class="pc-line"><span class="pc-label">Desde</span>
        <input class="pc-input" id="backPlace" maxlength="60" placeholder="ciudad, país"></label>
      <label class="pc-line pc-date-line"><span class="pc-label">Fecha</span>
        <span class="pc-date-text" id="backDateText"></span>
        <input class="pc-date-input" id="backDate" type="date" aria-label="Fecha"></label>
    </div>`;
  const els = {
    poem: backEl.querySelector(".pc-poem"),
    author: backEl.querySelector("#backAuthor"),
    name: backEl.querySelector("#backName"),
    place: backEl.querySelector("#backPlace"),
    date: backEl.querySelector("#backDate"),
    dateText: backEl.querySelector("#backDateText"),
    stampBox: backEl.querySelector("#editorStampBox")
  };
  for (const input of [els.author, els.name, els.place, els.date]) {
    input.addEventListener("input", updateEditorDataUI);
    input.addEventListener("change", updateEditorDataUI);
  }
  // La fecha se ve escrita con palabras; tocar la línea abre el calendario
  els.date.parentElement.addEventListener("click", (e) => {
    e.preventDefault();
    if (calendarEl && calendarEl.classList.contains("open")) closeCalendar();
    else openCalendar(els.date, els.date.parentElement);
  });
  return els;
}

// ---- Calendario propio, en café ----
// Escribe la fecha elegida en el input escondido (como "2026-11-11")
let calendarEl = null, calendarInput = null, calendarAnchor = null, calendarMonth = null;
const CAL_WEEKDAYS = ["L", "M", "M", "J", "V", "S", "D"];
const isoDate = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");

function buildCalendar() {
  calendarEl = document.createElement("div");
  calendarEl.className = "pc-calendar";
  calendarEl.innerHTML = `
    <div class="cal-head">
      <button class="cal-nav cal-prev" aria-label="Mes anterior">‹</button>
      <span class="cal-title"></span>
      <button class="cal-nav cal-next" aria-label="Mes siguiente">›</button>
    </div>
    <div class="cal-grid"></div>
    <div class="cal-foot">
      <button class="cal-clear">Borrar</button>
      <button class="cal-today">Hoy</button>
    </div>`;
  document.body.appendChild(calendarEl);
  const shift = (n) => {
    calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + n, 1);
    renderCalendar();
  };
  calendarEl.querySelector(".cal-prev").addEventListener("click", () => shift(-1));
  calendarEl.querySelector(".cal-next").addEventListener("click", () => shift(1));
  calendarEl.querySelector(".cal-clear").addEventListener("click", () => pickCalendarDate(""));
  calendarEl.querySelector(".cal-today").addEventListener("click", () => pickCalendarDate(isoDate(new Date())));
  // Tocar fuera (o Esc) lo cierra; también si la página se mueve
  document.addEventListener("pointerdown", (e) => {
    if (!calendarEl.classList.contains("open")) return;
    if (calendarEl.contains(e.target) || calendarAnchor.contains(e.target)) return;
    closeCalendar();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeCalendar(); });
  window.addEventListener("resize", closeCalendar);
  window.addEventListener("scroll", closeCalendar, true);
}

function openCalendar(input, anchor) {
  if (!calendarEl) buildCalendar();
  calendarInput = input;
  calendarAnchor = anchor;
  const [y, m] = input.value ? input.value.split("-").map(Number) : [];
  const base = input.value ? new Date(y, m - 1, 1) : new Date();
  calendarMonth = new Date(base.getFullYear(), base.getMonth(), 1);
  renderCalendar();
  calendarEl.classList.add("open");
  // Arriba de la línea de la fecha si cabe; si no, debajo
  const r = anchor.getBoundingClientRect();
  const w = calendarEl.offsetWidth, h = calendarEl.offsetHeight;
  const top = r.top - h - 8 >= 8 ? r.top - h - 8 : Math.min(r.bottom + 8, window.innerHeight - h - 8);
  const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
  calendarEl.style.top = top + "px";
  calendarEl.style.left = left + "px";
}

function closeCalendar() {
  if (calendarEl) calendarEl.classList.remove("open");
}

function renderCalendar() {
  const y = calendarMonth.getFullYear(), m = calendarMonth.getMonth();
  const title = calendarMonth.toLocaleDateString("es-CL", { month: "long", year: "numeric" });
  calendarEl.querySelector(".cal-title").textContent = title.charAt(0).toUpperCase() + title.slice(1);
  const grid = calendarEl.querySelector(".cal-grid");
  grid.innerHTML = CAL_WEEKDAYS.map((d) => `<span class="cal-wd">${d}</span>`).join("");
  // Parte el lunes de la semana del día 1; siempre 6 semanas
  const offset = (new Date(y, m, 1).getDay() + 6) % 7;
  const today = isoDate(new Date());
  for (let i = 0; i < 42; i++) {
    const d = new Date(y, m, 1 - offset + i);
    const iso = isoDate(d);
    const btn = document.createElement("button");
    btn.className = "cal-day";
    btn.textContent = d.getDate();
    if (d.getMonth() !== m) btn.classList.add("other");
    if (iso === today) btn.classList.add("today");
    if (iso === calendarInput.value) btn.classList.add("selected");
    btn.addEventListener("click", () => pickCalendarDate(iso));
    grid.appendChild(btn);
  }
}

function pickCalendarDate(iso) {
  calendarInput.value = iso;
  calendarInput.dispatchEvent(new Event("change"));
  closeCalendar();
}

// Los datos escritos atrás (la fecha ya con su estación)
function postcardData() {
  if (!editorBackEls) return { name: "", place: "", date: "", author: "", poem: poemTextarea.value().trim() };
  return {
    name: editorBackEls.name.value.trim(),
    place: editorBackEls.place.value.trim(),
    date: formatPostcardDate(editorBackEls.date.value),
    author: editorBackEls.author.value.trim(),
    poem: poemTextarea.value().trim()
  };
}

function editorDataComplete() {
  const d = postcardData();
  return !!(d.name && d.place && d.date && d.author && d.poem);
}

// Al escribir: muestra la fecha con su estación y, con todo completo,
// aparecen "Guardar portada / contraportada" y la estampilla arriba
function updateEditorDataUI() {
  if (!editorBackEls) return;
  const dateText = formatPostcardDate(editorBackEls.date.value);
  editorBackEls.dateText.textContent = dateText || "elige la fecha";
  editorBackEls.dateText.classList.toggle("empty", !dateText);
  // Remarca los datos que faltan por rellenar
  const fields = [editorBackEls.author, editorBackEls.name, editorBackEls.place, editorBackEls.date];
  for (const input of fields) input.closest("label").classList.toggle("pc-missing", !input.value.trim());
  maskEditorEl.classList.toggle("step3", isEditorStep3());
  maskEditorEl.classList.toggle("data-ok", isEditorStep3() && editorDataComplete());
  if (isEditorStep3()) maskEditorHintEl.textContent = editorHint();
}

// El poema del reverso es el que se escribió en el panel
function fillEditorBack() {
  if (!editorBackEls) return;
  editorBackEls.poem.textContent = poemTextarea.value().trim();
  fitPoemText(editorBackEls.poem);
}

// ---- "Descargar postal": se pega la estampilla, la postal entra al
// sobre y se descarga ----
function downloadPostcard() {
  if (!isEditorStep3() || maskEditorEl.classList.contains("sending")) return;
  closeCalendar();
  if (!editorDataComplete()) {
    // Faltan datos: se muestra el reverso y parpadean los que faltan
    editorCardEl.classList.add("flipped");
    maskEditorEl.classList.remove("nudge");
    void maskEditorEl.offsetWidth; // reinicia la animación
    maskEditorEl.classList.add("nudge");
    const first = editorBackEls.stampBox.closest(".postcard-back").querySelector(".pc-missing input:not([type=date])");
    if (first) first.focus();
    return;
  }
  editorCardEl.classList.add("flipped");
  // En el teléfono el menú para guardar solo se abre justo al tocar el botón
  if (isMobile()) saveBothSides();
  setTimeout(playEnvelope, 300); // la postal entra a un sobre y se cierra
}

// ---- El sobre: la postal se achica, sube el sobre, la postal entra
// (sin salirse por abajo), se cierra la solapa y aparece el correo ----
const CARD_SHRINK_MS = 700;      // primero la postal se achica en su lugar
const ENVELOPE_RISE_MS = 800;    // luego sube el sobre desde abajo
const CARD_IN_MS = 900;          // la postal baja y entra al sobre
const CARD_SINK_MS = 250;        // pausa con la postal ya dentro del sobre
const FLAP_CLOSE_MS = 700;       // recién entonces se cierra la solapa
let envelopeTimers = [];

function playEnvelope() {
  if (!maskEditorOpen) return;
  const envLayers = maskEditorEl.querySelectorAll(".envelope"); // detrás y delante de la postal
  const env = envLayers[0];
  const card = editorCardEl;

  // Desaparecen los botones y textos (primero, porque al irse la postal se
  // corre de lugar y hay que medirla ya en su nueva posición)
  maskEditorEl.classList.add("sending");

  // Posiciones en la página (no en la pantalla): en el teléfono la página
  // se desplaza hasta el sobre mientras tanto
  const pageRect = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left + window.scrollX, top: r.top + window.scrollY, width: r.width, height: r.height };
  };
  const cardRect = pageRect(card);
  const boxRect = pageRect(maskEditorEl);

  // Tamaño del sobre: un poco más chico que la postal, abajo y al centro
  const envW = Math.min(cardRect.width * 0.72, boxRect.width * 0.7);
  const envH = envW * 0.62;
  envLayers.forEach((layer) => {
    layer.style.width = envW + "px";
    layer.style.height = envH + "px";
  });

  // En el teléfono el sobre sube desde abajo del editor: se baja la página
  // para que se vea todo (la postal y el sobre)
  if (isMobile()) maskEditorEl.scrollIntoView({ behavior: "smooth", block: "end" });

  const later = (fn, ms) => envelopeTimers.push(setTimeout(fn, ms));
  const scale = Math.min((envW * 0.88) / cardRect.width, (envH * 0.86) / cardRect.height);
  const ease = "cubic-bezier(.45,.05,.35,1)";
  const smallH = cardRect.height * scale; // alto de la postal ya achicada

  // 1) La postal se achica en su lugar, al tamaño que cabe en el sobre
  requestAnimationFrame(() => {
    card.style.transition = "transform " + CARD_SHRINK_MS + "ms " + ease;
    card.style.transform = "scale(" + scale + ")";
  });

  // 2) Sube el sobre abierto
  later(() => maskEditorEl.classList.add("env-up"), CARD_SHRINK_MS);

  // 3) La postal (ya chica) baja y entra al sobre, detrás del bolsillo.
  //    Queda entera dentro del sobre (nunca pasa su borde de abajo): el
  //    bolsillo tapa la parte de abajo y la solapa, al cerrarse, la de arriba
  later(() => {
    const envRect = pageRect(env);
    const dx = (envRect.left + envRect.width / 2) - (cardRect.left + cardRect.width / 2);
    const dy = (envRect.top + envRect.height * 0.5) - (cardRect.top + cardRect.height / 2);
    card.style.transition = "transform " + CARD_IN_MS + "ms " + ease;
    card.style.transform = "translate(" + dx + "px, " + dy + "px) scale(" + scale + ")";
  }, CARD_SHRINK_MS + ENVELOPE_RISE_MS);

  // 4) Una pausa breve y se cierra la solapa encima
  later(() => maskEditorEl.classList.add("env-closing"),
    CARD_SHRINK_MS + ENVELOPE_RISE_MS + CARD_IN_MS + CARD_SINK_MS + 100);

  // 5) Con la solapa ya cerrada, la postal (tapada) deja de existir
  later(() => { card.style.opacity = "0"; },
    CARD_SHRINK_MS + ENVELOPE_RISE_MS + CARD_IN_MS + CARD_SINK_MS + 100 + FLAP_CLOSE_MS);

  // 6) Se descargan las dos fotos y aparece el mensaje con el correo
  // En el teléfono no se guardan solas: el menú para guardarlas en la
  // galería necesita que la persona toque un botón ("Guardar en mis fotos")
  later(() => {
    const mobile = isMobile();
    maskEditorEl.querySelector(".sent-save").style.display = mobile ? "" : "none";
    maskEditorEl.querySelector(".share-note").textContent = mobile
      ? "Si no quedaron guardadas, toca «Guardar otra vez»."
      : "";
    if (!mobile) saveBothSides();
    maskEditorEl.classList.add("sent");
  }, CARD_SHRINK_MS + ENVELOPE_RISE_MS + CARD_IN_MS + CARD_SINK_MS + 100 + FLAP_CLOSE_MS + 200);
}

function resetEnvelope() {
  envelopeTimers.forEach(clearTimeout);
  envelopeTimers = [];
  maskEditorEl.classList.remove("sending", "env-up", "env-closing", "sent", "stamped", "nudge");
  editorCardEl.style.transition = "";
  editorCardEl.style.transform = "";
  editorCardEl.style.clipPath = "";
  editorCardEl.style.opacity = "";
}

// ---- Guardar portada (foto + poema) y contraportada (reverso) ----
// ---------------------------------------------------------------------
// GUARDAR IMÁGENES
// En el computador se descargan. En el teléfono se abre el menú de
// compartir, que tiene "Guardar imagen" (así quedan en la galería de
// fotos, no en Descargas) y también deja mandarlas por correo.
// Ese menú solo se abre si la persona acaba de tocar un botón, por eso
// todo aquí es inmediato (sin esperas antes de compartir).
// ---------------------------------------------------------------------
function canvasToFile(canvasEl, name, type) {
  type = type || "image/jpeg";
  const dataUrl = canvasEl.toDataURL(type, 0.92);
  const bytes = atob(dataUrl.split(",")[1]);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new File([arr], name, { type });
}

function downloadFiles(files) {
  files.forEach((file, i) => {
    setTimeout(() => {
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.download = file.name;
      link.href = url;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }, i * 300); // una tras otra, para que el navegador no bloquee la segunda
  });
}

function saveImageFiles(files) {
  if (!isMobile()) { downloadFiles(files); return; }
  let canShare = false;
  try { canShare = !!(navigator.canShare && navigator.canShare({ files })); } catch (err) { /* sin menú */ }
  // Sin menú de compartir (por ejemplo, dentro de Instagram o WhatsApp, o
  // sin https) se muestran las fotos para guardarlas manteniéndolas presionadas
  if (!canShare) { showSaveSheet(files); return; }
  navigator.share({ files }).catch((err) => {
    // Si la persona cerró el menú, no se hace nada; si falló, se muestran las fotos
    if (err && err.name !== "AbortError") showSaveSheet(files);
  });
}

// Respaldo en el teléfono: las fotos en grande, para mantenerlas
// presionadas y elegir "Guardar en Fotos" / "Descargar imagen"
let saveSheetEl = null;
function showSaveSheet(files) {
  if (!saveSheetEl) {
    saveSheetEl = document.createElement("div");
    saveSheetEl.id = "saveSheet";
    saveSheetEl.innerHTML = `
      <p class="save-sheet-title">Guarda tus fotos</p>
      <p class="save-sheet-hint">Mantén presionada cada foto y elige <strong>Guardar en Fotos</strong> (o <strong>Descargar imagen</strong>).</p>
      <div class="save-sheet-images"></div>
      <button class="primary-btn save-sheet-close">Listo</button>`;
    document.body.appendChild(saveSheetEl);
    saveSheetEl.querySelector(".save-sheet-close").addEventListener("click", () => {
      saveSheetEl.classList.remove("open");
      saveSheetEl.querySelectorAll("img").forEach((img) => URL.revokeObjectURL(img.src));
      saveSheetEl.querySelector(".save-sheet-images").innerHTML = "";
      document.body.classList.toggle("viewer-open", false);
      updateScrollLock();
    });
  }
  const box = saveSheetEl.querySelector(".save-sheet-images");
  box.innerHTML = "";
  for (const file of files) {
    const img = document.createElement("img");
    img.src = URL.createObjectURL(file);
    img.alt = file.name;
    box.appendChild(img);
  }
  saveSheetEl.classList.add("open");
  saveSheetEl.scrollTop = 0;
  document.body.classList.add("viewer-open");
}

function portadaFile() {
  return canvasToFile(cnv.elt, "portada-" + Date.now() + ".jpg");
}

function contraportadaFile() {
  return canvasToFile(drawBackCanvas(), "contraportada-" + Date.now() + ".jpg");
}

// Las dos juntas (en el teléfono, un solo menú para guardar ambas)
function saveBothSides() {
  if (appState !== "listo" || !photoReady) return;
  saveImageFiles([portadaFile(), contraportadaFile()]);
}

function savePortada() {
  if (appState !== "listo") return;
  saveImageFiles([portadaFile()]);
}

// Dibuja el reverso como imagen, del mismo tamaño que la foto
function drawBackCanvas() {
  const W = originalImg.width, H = originalImg.height;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  const hRef = Math.min(H, W / POSTCARD_RATIO);
  const base = hRef * 0.045;
  const pad = hRef * 0.08, gap = hRef * 0.06;
  const font = (size, weight) => (weight || "400") + " " + size + "px -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
  const d = postcardData();

  ctx.fillStyle = "#F7F3EA";
  ctx.fillRect(0, 0, W, H);

  const colW = (W - 2 * pad - 2 * gap) / 2;
  // Poema (respeta los saltos de línea y parte las líneas largas)
  // Arma los renglones con un tamaño de letra dado ("" = renglón vacío)
  const poemLines = (size) => {
    ctx.font = font(size);
    const lines = [];
    for (const para of d.poem.split("\n")) {
      if (!para.trim()) { lines.push(""); continue; }
      let line = "";
      for (const w of para.split(" ")) {
        const test = line ? line + " " + w : w;
        if (ctx.measureText(test).width > colW && line) { lines.push(line); line = w; }
        else line = test;
      }
      if (line) lines.push(line);
    }
    return lines;
  };
  // Si no cabe entero sobre "Poema por", la letra se achica de a poco
  const poemMaxH = H - 2 * pad - base * 0.7 * 2; // deja lugar para "Poema por" y un espacio
  let poemSize = base * 0.85;
  let lines = poemLines(poemSize);
  while (lines.length * poemSize * 1.3 > poemMaxH && poemSize > base * 0.3) {
    poemSize *= 0.95;
    lines = poemLines(poemSize);
  }
  const lh = poemSize * 1.3;
  ctx.fillStyle = "#444444";
  ctx.textBaseline = "top";
  ctx.font = font(poemSize);
  let y = pad;
  for (const line of lines) {
    if (line) ctx.fillText(line, pad, y);
    y += lh;
  }
  // Poema por
  ctx.fillStyle = "#888888";
  ctx.font = font(base * 0.7);
  ctx.textBaseline = "bottom";
  ctx.fillText("Poema por: " + d.author, pad, H - pad);

  // Línea al medio
  const divX = pad + colW + gap;
  ctx.fillStyle = "#CCCCCC";
  ctx.fillRect(divX, pad, Math.max(1, hRef * 0.002), H - 2 * pad);

  // Sello (arriba a la derecha): por ahora vacío, dos anillos como en pantalla
  const x1 = divX + gap, right = W - pad;
  const sealR = hRef * 0.12;
  const sealX = right - sealR, sealY = pad + sealR;
  ctx.strokeStyle = "#AAAAAA";
  ctx.lineWidth = Math.max(1, hRef * 0.003);
  ctx.beginPath(); ctx.arc(sealX, sealY, sealR, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = Math.max(1, hRef * 0.002);
  ctx.beginPath(); ctx.arc(sealX, sealY, sealR * 0.82, 0, Math.PI * 2); ctx.stroke();

  // De / Desde / Fecha (abajo, con su línea)
  const aSize = base * 0.7, labelSize = aSize * 0.7;
  const rows = [["DE", d.name], ["DESDE", d.place], ["FECHA", d.date]];
  const rowH = aSize * 1.9;
  let ry = H - pad - rowH * rows.length;
  ctx.textBaseline = "alphabetic";
  for (const [label, value] of rows) {
    const baseY = ry + rowH - aSize * 0.45;
    ctx.fillStyle = "#888888"; ctx.font = font(labelSize, "600");
    ctx.fillText(label, x1, baseY);
    const lw = ctx.measureText(label).width;
    ctx.fillStyle = "#444444"; ctx.font = font(aSize);
    ctx.fillText(value, x1 + lw + aSize * 0.6, baseY);
    ctx.fillStyle = "#CCCCCC";
    ctx.fillRect(x1, ry + rowH, right - x1, Math.max(1, hRef * 0.002));
    ry += rowH;
  }
  return c;
}

function saveContraportada() {
  if (!photoReady) return;
  saveImageFiles([contraportadaFile()]);
}

function refreshLargeViews() {
  if (maskEditorOpen && editorPhase === "done") {
    animLines = lastPoemLines;
    drawEditorFrame(1, animLines.length ? 1 : 0);
    maskEditorHintEl.textContent = editorHint();
    fillEditorBack();
  }
  if (resultViewerOpen) resultViewerImgEl.src = cnv.elt.toDataURL("image/jpeg", 0.92);
}

// Abre la foto en grande y vuelve a trazar las líneas y escribir el poema
// (después pregunta de nuevo letra blanca o negra). Si ya está abierta,
// no la interrumpe, para poder seguir escribiendo tranquila.
function replayPoemAnimation() {
  if (!photoReady || !maskReady || !maskImg) return;
  if (maskEditorOpen) return;
  closeResultViewer();
  openMaskEditor();
  startPoemAnimation();
}

function finishAnimation(hint) {
  editorPhase = "done";
  updateStepUI();
  maskEditorHintEl.textContent = hint;
  maskEditorEl.classList.add("done");
}

// ---------------------------------------------------------------------
// VER EL RESULTADO EN GRANDE
// Tocar el recuadro de abajo muestra la foto con el poema, en grande,
// encima de las postales. Tocar de nuevo (o Esc) la cierra.
// ---------------------------------------------------------------------
let resultViewerEl, resultViewerImgEl;
let resultViewerOpen = false;

function openResultViewer() {
  if (!photoReady) return;
  if (!resultViewerEl) {
    resultViewerEl = document.createElement("div");
    resultViewerEl.id = "resultViewer";
    resultViewerImgEl = document.createElement("img");
    resultViewerImgEl.alt = "Tu retrato con el poema";
    const hint = document.createElement("div");
    hint.className = "mask-editor-hint";
    hint.textContent = "Toca para cerrar";
    resultViewerEl.append(resultViewerImgEl);
    // Aquí solo se guarda (la letra y el envío están en la vista del poema)
    const saveRow = document.createElement("div");
    saveRow.className = "btn-row final-row save-only";
    saveRow.innerHTML = `<button class="primary-btn">Guardar imagen</button>`;
    saveRow.querySelector("button").addEventListener("click", onSaveClick);
    finalRows.push(saveRow);
    saveRow.classList.toggle("ready", appState === "listo");
    resultViewerEl.append(saveRow, hint);
    document.getElementById("below").appendChild(resultViewerEl);
    resultViewerEl.addEventListener("click", (e) => { if (!e.target.closest("button")) closeResultViewer(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && resultViewerOpen) closeResultViewer(); });
  }
  resultViewerImgEl.src = cnv.elt.toDataURL("image/jpeg", 0.92); // lo que se ve ahora en el resultado
  resultViewerOpen = true;
  resultViewerEl.classList.add("open");
  updateScrollLock();
}

function closeResultViewer() {
  if (!resultViewerOpen) return;
  resultViewerOpen = false;
  resultViewerEl.classList.remove("open");
  updateScrollLock();
}

// Pinta o borra un trazo entre dos puntos (en coordenadas del editor)
function brushStroke(from, to) {
  if (!maskImg || !maskEditorFit) return;
  const fit = maskEditorFit;
  const toImg = (p) => ({ x: (p.x - fit.x) / fit.scale, y: (p.y - fit.y) / fit.scale });
  const a = toImg(from);
  const b = toImg(to);
  const size = BRUSH_SIZE / fit.scale;
  const ctx = maskImg.canvas.getContext("2d");
  ctx.save();
  ctx.globalCompositeOperation = brushMode === "erase" ? "destination-out" : "source-over";
  ctx.strokeStyle = "#FFFFFF";
  ctx.fillStyle = "#FFFFFF";
  ctx.lineWidth = size;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  // Un círculo en la punta: así un solo toque (sin arrastrar) también marca
  ctx.beginPath();
  ctx.arc(b.x, b.y, size / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  if (maskImg.setModified) maskImg.setModified(true);
}

function setupMaskBrush() {
  const canvasEl = maskEditorCanvasEl;
  let last = null;
  let frameQueued = false;
  const pointAt = (e) => {
    const r = canvasEl.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const refresh = () => {
    if (frameQueued) return;
    frameQueued = true;
    requestAnimationFrame(() => { frameQueued = false; maskEditorFit = drawPhotoWithMask(canvasEl); });
  };

  canvasEl.addEventListener("pointerdown", (e) => {
    if (!maskEditorOpen || editorPhase !== "edit" || !maskReady) return;
    e.preventDefault();
    canvasEl.setPointerCapture(e.pointerId);
    last = pointAt(e);
    brushStroke(last, last);
    refresh();
  });
  canvasEl.addEventListener("pointermove", (e) => {
    if (!last) return;
    const p = pointAt(e);
    brushStroke(last, p);
    last = p;
    refresh();
  });
  const end = () => {
    if (!last) return;
    last = null;
    schedulePoemRender(); // el poema se vuelve a acomodar con la silueta nueva
  };
  canvasEl.addEventListener("pointerup", end);
  canvasEl.addEventListener("pointercancel", end);
}

// Solo deja guardar cuando ya hay un retrato terminado
// Colorea la sección de la etapa en que se está:
// 0) ninguna: al entrar, sin foto todavía
// 1) silueta: editando la silueta
// 2) poema: falta escribirlo, o se está escribiendo
// 3) retrato: el retrato con poema está listo
function updateStepUI() {
  const poemFocused = poemTextarea && document.activeElement === poemTextarea.elt;
  const hasPoem = poemTextarea && poemTextarea.value().trim().length > 0;
  // En la foto grande: mientras salen las líneas, se escribe el poema y se
  // elige la letra, sigue siendo "poema"; tras "Listo" pasa a "retrato"
  const choosingLetter = maskEditorOpen && editorPhase === "done" &&
    maskEditorFinalEl && !maskEditorFinalEl.classList.contains("confirmed");
  let step;
  if (!photoReady) step = 0;                      // al entrar, sin foto: ninguna marcada
  else if (maskEditorOpen && editorPhase === "edit") step = 1;
  else if ((maskEditorOpen && editorPhase === "anim") || choosingLetter) step = 2;
  else if (maskEditorOpen && editorPhase === "done") step = 3;
  else if (poemFocused || !hasPoem || appState !== "listo") step = 2;
  else step = 3;
  ["colPhoto", "colPoem", "colResult"].forEach((id, i) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("active", i + 1 === step);
  });
  updateStepNav(step);
  placePoemBox(step);
}

// En el teléfono, en la etapa del poema dentro del editor (tras "Listo" en
// la silueta, hasta elegir la letra), el cuadro de renglones aparece justo
// bajo la foto (la foto no se mueve): lo que escribes o pegas aparece de
// inmediato sobre las líneas.
// Fuera de esa etapa vuelve a su lugar en el panel.
function placePoemBox(step) {
  const poemBoxEl = document.getElementById("poemBox");
  const colPoemEl = document.getElementById("colPoem");
  if (!poemBoxEl || !colPoemEl) return;
  const inEditor = isMobile() && maskEditorOpen && step === 2 && !!maskEditorEl;
  if (inEditor) {
    if (poemBoxEl.parentElement !== maskEditorEl) editorCardEl.after(poemBoxEl);
  } else if (poemBoxEl.parentElement !== colPoemEl) {
    colPoemEl.insertBefore(poemBoxEl, document.getElementById("poemPlasmar"));
  }
}

// ---------------------------------------------------------------------
// TELÉFONO: UNA ETAPA A LA VEZ
// El panel muestra solo la etapa elegida (1 silueta, 2 poema, 3 retrato).
// Avanza sola al cerrar la foto en grande, y también se puede tocar la
// barra de pasos. Sin foto, solo se puede estar en la 1.
// ---------------------------------------------------------------------
let mobileStep = 1;

function setMobileStep(n) {
  mobileStep = clampStep(n);
  updateStepUI();
  // Lo que estaba escondido medía 0: se vuelve a dibujar a su tamaño
  layoutBoxes();
  drawPreview();
}

// Un paso de la barra: si el editor está abierto, primero se cierra
// En el teléfono, con foto, volver a "Retrato" abre el editor con sus
// botones (Cambiar autorretrato, Pintar, Borrar, Listo), y volver a
// "Postal" (con el retrato listo) abre la postal con los datos y los
// botones para guardar. "Poema" muestra los renglones para escribir.
function goToStep(n) {
  if (!stepAllowed(n)) return; // todavía no: falta terminar la etapa anterior
  if (maskEditorOpen) closeMaskEditor();
  if (isMobile() && photoReady) {
    if (n === 1) { setMobileStep(1); openMaskEditor(); return; }
    if (n === 3 && portraitReady()) { setMobileStep(3); openPostcardStep(); return; }
  }
  setMobileStep(n);
}

// Solo se avanza en la barra cuando la etapa anterior está lista:
// al Poema, tras tocar "Listo" en la silueta; a la Postal, tras elegir la
// letra y tocar "Listo" (con el retrato terminado). Volver atrás, siempre.
let silhouetteDone = false;
let letterDone = false;

function stepAllowed(n) {
  if (n === 1) return true;
  if (n === 2) return photoReady && silhouetteDone;
  return photoReady && silhouetteDone && letterDone && portraitReady();
}

// La etapa más avanzada a la que se puede llegar (sin pasarse de n)
function clampStep(n) {
  while (n > 1 && !stepAllowed(n)) n--;
  return n;
}

function portraitReady() {
  return maskReady && !!maskImg && appState === "listo" && lastPoemLines.length > 0;
}

// Abre el editor directo en la postal ya terminada, sin repetir la animación
function openPostcardStep() {
  openMaskEditor();
  editorAnimId++;                        // por si quedaba alguna animación
  animSegments = computeGridSegments();
  animLines = lastPoemLines;
  editorPhase = "done";
  drawEditorFrame(1, 1);
  maskEditorEl.classList.add("done");
  maskEditorFinalEl.classList.add("confirmed"); // la letra ya se eligió antes
  fillEditorBack();
  editorCardEl.classList.add("flipped");        // muestra el reverso con los datos
  updateEditorDataUI();
  maskEditorHintEl.textContent = editorHint();
  updateMaskEditorUI();
}

// editorStep: la etapa en que va el editor (1 silueta, 2 poema, 3 postal),
// para marcarla en la barra mientras está abierto
function updateStepNav(editorStep) {
  const panelEl = document.getElementById("panel");
  if (!panelEl) return;
  mobileStep = clampStep(mobileStep);
  // Con el editor abierto en el teléfono, se esconden las etapas y queda él
  const inlineEditor = maskEditorOpen && isMobile();
  panelEl.dataset.step = inlineEditor ? "editor" : mobileStep;
  const current = inlineEditor && editorStep ? editorStep : mobileStep;
  document.querySelectorAll(".step-tab").forEach((tab) => {
    const n = Number(tab.dataset.step);
    tab.classList.toggle("current", n === current);
    tab.disabled = !stepAllowed(n);
  });
  const plasmar = document.getElementById("poemPlasmar");
  if (plasmar) plasmar.disabled = !(maskReady && poemTextarea.value().trim().length > 0);
}

function refreshSaveButton() {
  updateStepUI();
  const ready = appState === "listo";
  for (const row of finalRows) row.classList.toggle("ready", ready);
}

// Si la foto es muy vertical (por ejemplo 9:16 de celular), se recorta a
// 4:5. Se corta más de abajo que de arriba, para no perder la cabeza.
const MAX_TALL_RATIO = 5 / 4;   // alto / ancho máximo permitido
const CROP_TOP_SHARE = 0.3;     // de lo que sobra, cuánto se corta arriba (el resto, abajo)
function cropIfTooTall(img) {
  const maxH = Math.round(img.width * MAX_TALL_RATIO);
  if (img.height <= maxH) return img;
  const extra = img.height - maxH;
  return img.get(0, Math.round(extra * CROP_TOP_SHARE), img.width, maxH);
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

  for (const [white, black] of colorButtonPairs) {
    white.classList.toggle("toggle-btn-active", isWhite);
    black.classList.toggle("toggle-btn-active", !isWhite);
  }
}

// Descarga la imagen final (foto + poema)
function onSaveClick() {
  if (appState !== "listo") return;
  saveImageFiles([canvasToFile(cnv.elt, "retrato-poema-" + Date.now() + ".png", "image/png")]);
}

// ---------------------------------------------------------------------
// ENVIAR LA POSTAL POR CORREO
// Muestra una ventanita con el correo al que hay que enviar la postal:
// la persona solo adjunta la portada y la contraportada (sus datos ya
// van escritos en la contraportada).
// ---------------------------------------------------------------------
const SHARE_EMAIL = "bernardita.jesus1@gmail.com";

function openShareDialog() {
  if (appState !== "listo") return;
  shareCopyEl.textContent = "Copiar correo";
  shareDialogEl.classList.add("open");
  shareCopyEl.focus();
}

function closeShareDialog() {
  shareDialogEl.classList.remove("open");
}

// Copia el correo al portapapeles
async function copyShareData() {
  try {
    await navigator.clipboard.writeText(SHARE_EMAIL);
    shareCopyEl.textContent = "¡Copiado!";
  } catch (err) {
    shareCopyEl.textContent = "No se pudo copiar";
  }
}

// Descarga portada y contraportada en JPG (pesan menos para el correo)
function downloadPostcardForEmail() {
  saveBothSides();
}

// Arma la ventanita para enviar la postal (queda escondida hasta usarla)
function buildShareDialog() {
  shareDialogEl = document.createElement("div");
  shareDialogEl.id = "shareDialog";
  shareDialogEl.innerHTML = `
    <div class="share-card">
      <h2>Enviar mi postal</h2>
      <p>Escribe a este correo:</p>
      <p class="share-email">${SHARE_EMAIL}</p>
      <p>Adjunta las dos imágenes de tu postal: la <strong>portada</strong> y la <strong>contraportada</strong>.
        Tus datos ya van escritos en la contraportada.</p>
      <p class="share-note"></p>
      <div class="btn-row">
        <button class="toggle-btn" id="shareCopy">Copiar correo</button>
        <button class="toggle-btn" id="shareDownload">Descargar portada y contraportada</button>
      </div>
      <div class="btn-row">
        <button class="primary-btn" id="shareDone">Listo</button>
      </div>
    </div>`;
  document.body.appendChild(shareDialogEl);

  shareCopyEl = shareDialogEl.querySelector("#shareCopy");
  shareCopyEl.addEventListener("click", copyShareData);
  shareDialogEl.querySelector("#shareDownload").addEventListener("click", downloadPostcardForEmail);
  shareDialogEl.querySelector("#shareDone").addEventListener("click", closeShareDialog);
  // Tocar fuera de la ventanita o apretar Esc la cierra
  shareDialogEl.addEventListener("click", (e) => { if (e.target === shareDialogEl) closeShareDialog(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && shareDialogEl.classList.contains("open")) closeShareDialog();
  });
}

// ---------------------------------------------------------------------
// ARMAR EL RETRATO (detectar persona + acomodar el poema)
// ---------------------------------------------------------------------
// Espera un momento a que dejes de escribir y luego dibuja el poema,
// para no recalcular con cada letra.
function schedulePoemRender() {
  clearTimeout(renderTimer);
  // Con la foto abierta en grande se actualiza más rápido, casi mientras escribes
  renderTimer = setTimeout(renderPoem, maskEditorOpen || resultViewerOpen ? 250 : 500);
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
    lastPoemLines = [];
    refreshSaveButton();
    redraw();
    refreshLargeViews();
    return;
  }

  appState = "procesando";
  refreshSaveButton();

  buildPoemLines(poemText, () => myRenderId !== renderId, (layer, lines) => {
    if (myRenderId !== renderId) {
      layer.remove(); // llegó un cambio más nuevo; este dibujo ya no sirve
      return;
    }
    clearPoemLayer();
    gridLayer = layer;
    lastPoemLines = lines;
    appState = "listo";
    refreshSaveButton();
    redraw();
    refreshLargeViews();
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

// ---------------------------------------------------------------------
// SÍLABAS: dónde se puede cortar una palabra (en español) con guion.
// Reglas básicas: una consonante entre vocales va con la vocal siguiente
// (ca-sa); dos consonantes se separan (can-to) salvo los grupos que no se
// separan (bl, br, cl, cr, dr, fl, fr, gl, gr, kl, kr, pl, pr, tr) y las
// letras dobles ch, ll, rr; dos vocales fuertes se separan (po-e-ma).
// Nunca deja una sola letra sola a un lado del corte.
// ---------------------------------------------------------------------
const MIN_HYPHEN_LETTERS = 7; // solo se cortan con guion las palabras de 7 letras o más

function syllableBreaks(word) {
  const w = word.toLowerCase();
  const isVowel = (c) => "aeiouáéíóúü".includes(c);
  const isStrong = (c) => "aeoáéíóú".includes(c); // í y ú con tilde también se separan
  const isLetter = (c) => /[a-zñáéíóúü]/.test(c);

  // 1) Unidades: vocales, consonantes (ch/ll/rr/qu/gu cuentan como una) y otros signos
  const units = [];
  for (let i = 0; i < w.length;) {
    const c = w[i], d = w[i + 1] || "", e = w[i + 2] || "";
    if (!isLetter(c)) { units.push({ i, t: "x", s: c }); i++; continue; }
    if ((c === "c" && d === "h") || (c === "l" && d === "l") || (c === "r" && d === "r")) {
      units.push({ i, t: "c", s: c + d }); i += 2; continue;
    }
    if ((c === "q" || c === "g") && d === "u" && "eiéí".includes(e)) {
      units.push({ i, t: "c", s: c + "u" }); i += 2; continue;
    }
    if (c === "y" && !isVowel(d)) { units.push({ i, t: "v", s: c }); i++; continue; } // "y" sin vocal después suena a vocal
    units.push({ i, t: isVowel(c) ? "v" : "c", s: c }); i++;
  }

  // 2) Recorre: entre dos vocales (o grupos de vocales) decide dónde cortar
  const inseparable = /^(bl|br|cl|cr|dr|fl|fr|gl|gr|kl|kr|pl|pr|tr)$/;
  const breaks = [];
  let lastVowel = -1; // índice de la última unidad vocal vista
  for (let k = 0; k < units.length; k++) {
    if (units[k].t === "x") { lastVowel = -1; continue; } // no se corta cerca de signos
    if (units[k].t !== "v") continue;
    if (lastVowel >= 0) {
      const between = units.slice(lastVowel + 1, k); // solo consonantes
      const n = between.length;
      if (n === 0) {
        // dos vocales seguidas: se separan si ambas son fuertes (hiato)
        if (isStrong(units[lastVowel].s) && isStrong(units[k].s)) breaks.push(units[k].i);
      } else if (n === 1) {
        breaks.push(between[0].i);
      } else if (n === 2) {
        breaks.push(inseparable.test(between[0].s + between[1].s) ? between[0].i : between[1].i);
      } else if (n === 3) {
        breaks.push(inseparable.test(between[1].s + between[2].s) ? between[1].i : between[2].i);
      } else {
        breaks.push(between[n - 2].i);
      }
    }
    lastVowel = k;
  }

  // 3) Sin dejar una letra sola a ningún lado
  const letters = (str) => (str.match(/[a-zñáéíóúü]/gi) || []).length;
  return breaks.filter((b) => letters(word.slice(0, b)) >= 2 && letters(word.slice(b)) >= 2);
}

// Separa el poema en palabras
function poemToWords(poemText) {
  const cleaned = poemText.replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned.split(" ") : ["(poema vacío)"];
}

// En una fila de la imagen, encuentra los tramos que son parte del
// cuerpo (puede haber más de uno). Ignora huequitos chicos.
function scanRowSegments(mask, y, threshold, minWidth, maxGap, margin) {
  const w = mask.width;
  margin = margin || 0;
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

  // Nada pegado a los bordes: los tramos se recortan al margen
  return segments
    .map(([a, b]) => [Math.max(a, margin), Math.min(b, w - 1 - margin)])
    .filter(([a, b]) => (b - a) >= minWidth);
}

// Filas donde puede ir texto: cada lineSpacing, sin acercarse a los bordes
// de arriba y abajo más que el margen (más media letra, porque el texto
// va centrado en su fila)
function poemRows(h, scale) {
  const lineSpacing = CONFIG.lineSpacing * scale;
  const edge = CONFIG.edgeMargin * scale + (CONFIG.fontSize * scale) / 2;
  const rows = [];
  for (let y = Math.max(lineSpacing, edge); y <= h - edge; y += lineSpacing) rows.push(Math.floor(y));
  return rows;
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
  let pendingRest = null; // resto de una palabra cortada con guion, va primero en la línea siguiente
  const lines = [];
  const currentWord = () => (pendingRest !== null ? pendingRest : words[wordCursor % words.length]);
  const consumeWord = () => { pendingRest = null; wordCursor++; };

  function fillSegment(xStart, xEnd, y) {
    const availableWidth = xEnd - xStart;
    let line = "";
    let usedWidth = 0;
    let wordsUsed = 0;
    const maxWordsPerLine = 200;

    while (wordsUsed < maxWordsPerLine) {
      const word = currentWord();
      const wordWidth = layer.textWidth(word);
      const extra = line.length > 0 ? spaceWidth : 0;

      if (usedWidth + extra + wordWidth > availableWidth) {
        // No cabe entera: si es una palabra larga, se corta en la sílaba
        // más larga que quepa, con guion (las cortas pasan enteras a la otra línea)
        const room = availableWidth - usedWidth - extra;
        const isLong = (word.match(/[a-zñáéíóúü]/gi) || []).length >= MIN_HYPHEN_LETTERS;
        const cut = !isLong ? undefined : syllableBreaks(word).reverse()
          .find((b) => layer.textWidth(word.slice(0, b) + "-") <= room);
        if (cut !== undefined) {
          line += (line.length > 0 ? " " : "") + word.slice(0, cut) + "-";
          pendingRest = word.slice(cut);
        }
        break;
      }

      line += (line.length > 0 ? " " : "") + word;
      usedWidth += extra + wordWidth;
      consumeWord();
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
    lines.push({ y, x0: xStart, x1: xEnd, cx, text: line }); // para la animación del editor
  }

  const rows = poemRows(h, scale);
  const margin = CONFIG.edgeMargin * scale;

  runChunked(rows.length, 30, (i) => {
    if (isStale()) return; // no sigue trabajando en un dibujo descartado
    const y = rows[i];
    const segments = scanRowSegments(maskImg, y, threshold, minSegmentWidth, maxRowGap, margin);
    for (const [xStart, xEnd] of segments) {
      fillSegment(xStart, xEnd, y);
    }
  }, () => onComplete(layer, lines));
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
  background(243, 237, 220);
}

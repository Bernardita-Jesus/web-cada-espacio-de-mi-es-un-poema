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
let appState = "vacio"; // vacio -> procesando -> listo

// Elementos de la interfaz
let uploadBtn, fileInputEl, poemTextarea, generateBtnEl, statusDiv, cnv, canvasFrameEl;
let textColorWhiteBtn, textColorBlackBtn, saveBtnEl;

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

// Evita que p5 fuerce un tamaño fijo al canvas, para que la imagen
// se vea siempre completa y bien proporcionada.
function clearInlineCanvasSize(canvasEl) {
  canvasEl.elt.style.width = "";
  canvasEl.elt.style.height = "";
}

// ---------------------------------------------------------------------
// SETUP
// ---------------------------------------------------------------------
function setup() {
  injectStyles();
  buildInterface();

  noStroke();
  noLoop(); // sin animación, solo redibuja cuando hace falta
  pixelDensity(1);

  bodyPixModel = ml5.bodyPix(CONFIG.bodyPixOptions, () => {
    modelReady = true;
    updateStatus("");
    refreshGenerateButton();
    redraw();
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
      background: #f4f3f1; color: #2c2c2a;
      font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      overflow: hidden;
    }
    #app { display: flex; width: 100vw; height: 100vh; }
    #sidebar {
      width: 28%; min-width: 300px;
      background: #bcd4c7; border-right: 1px solid #dbd9d4;
      padding: 32px 24px; display: flex; flex-direction: column; gap: 16px;
    }
    #title {
      font-family: Georgia, "Times New Roman", serif;
      font-size: 32px; font-weight: 700; line-height: 1.25; margin: 0 0 8px 0;
      color: #AF5515;
    }
    .field-label { font-size: 13px; font-weight: 600; color: #85B19B; margin: 6px 0 -6px 0; }
    .primary-btn {
      display: block; width: 100%; text-align: center;
      padding: 10px 14px; background: #85B19B; color: #FEFAE5;
      border: none; border-radius: 5px; font-size: 13px; font-weight: 600;
      cursor: pointer; font-family: inherit;
    }
    .primary-btn:hover:not(:disabled) { background: #729d87; }
    .primary-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    #poemInput {
      width: 100%; background: #FEFAE5; border: 1px solid #dbd9d4;
      border-radius: 5px; color: #2c2c2a; font-size: 13px; padding: 10px;
      resize: vertical; font-family: inherit;
    }
    #poemInput:focus { outline: none; border-color: #85B19B; }
    .btn-row { display: flex; gap: 8px; }
    .toggle-btn {
      flex: 1;
      padding: 8px 10px;
      background: #FEFAE5;
      border: 1px solid #dbd9d4;
      border-radius: 5px;
      font-size: 12px;
      font-weight: 600;
      color: #2c2c2a;
      cursor: pointer;
      font-family: inherit;
      transition: background 0.15s, border-color 0.15s, color 0.15s;
    }
    .toggle-btn:hover { border-color: #85B19B; }
    .toggle-btn-active {
      background: #85B19B;
      border-color: #85B19B;
      color: #FEFAE5;
    }
    #status { margin-top: auto; font-size: 12px; color: #2c2c2a; line-height: 1.4; }
    #stage {
      flex: 1; display: flex; align-items: center; justify-content: center;
      padding: 5vh 5vw; background: #FAF7EA;
    }
    #canvasFrame {
      display: flex; position: relative;
      max-width: 100%; max-height: 100%;
    }
    #canvasFrame.frame-empty {
      background: #f2eed7; padding: 24px;
    }
    #canvasFrame canvas {
      display: block;
      max-width: 68vw; max-height: 82vh;
      width: auto; height: auto;
    }
    .corner {
      position: absolute;
      width: 22px; height: 22px;
      pointer-events: none;
    }
    .corner-tl { top: -9px; left: -9px; border-top: 3px solid #AF5515; border-left: 3px solid #AF5515; }
    .corner-tr { top: -9px; right: -9px; border-top: 3px solid #AF5515; border-right: 3px solid #AF5515; }
    .corner-bl { bottom: -9px; left: -9px; border-bottom: 3px solid #AF5515; border-left: 3px solid #AF5515; }
    .corner-br { bottom: -9px; right: -9px; border-bottom: 3px solid #AF5515; border-right: 3px solid #AF5515; }
  `;
  const styleEl = document.createElement("style");
  styleEl.innerHTML = css;
  document.head.appendChild(styleEl);
}

function buildInterface() {
  const appDiv = createDiv().id("app");

  // Panel lateral
  const sidebar = createDiv().id("sidebar").parent(appDiv);

  createElement("h1", "Ahora cada espacio de mí es un poema.")
    .id("title")
    .parent(sidebar);

  // Input de archivo escondido; se activa con el botón de subir
  fileInputEl = createFileInput(handleFileSelected);
  fileInputEl.hide();
  fileInputEl.parent(sidebar);

  uploadBtn = createButton("Subir tu autorretrato");
  uploadBtn.addClass("primary-btn");
  uploadBtn.parent(sidebar);
  uploadBtn.mousePressed(() => fileInputEl.elt.click());

  createDiv("Tu poema").addClass("field-label").parent(sidebar);

  poemTextarea = createElement("textarea", "");
  poemTextarea.id("poemInput");
  poemTextarea.attribute("rows", "9");
  poemTextarea.attribute("placeholder", "Escribe aquí el poema...");
  poemTextarea.parent(sidebar);
  poemTextarea.input(refreshGenerateButton);

  generateBtnEl = createButton("Plasmar poema");
  generateBtnEl.addClass("primary-btn");
  generateBtnEl.parent(sidebar);
  generateBtnEl.elt.disabled = true;
  generateBtnEl.mousePressed(onGenerateClick);

  // Elegir color del poema
  createDiv("Color del poema").addClass("field-label").parent(sidebar);
  const colorRow = createDiv().addClass("btn-row").parent(sidebar);

  textColorWhiteBtn = createButton("Blanca");
  textColorWhiteBtn.addClass("toggle-btn");
  textColorWhiteBtn.parent(colorRow);
  textColorWhiteBtn.mousePressed(() => setTextColor([255, 255, 255]));

  textColorBlackBtn = createButton("Negra");
  textColorBlackBtn.addClass("toggle-btn");
  textColorBlackBtn.parent(colorRow);
  textColorBlackBtn.mousePressed(() => setTextColor([0, 0, 0]));

  updateColorButtonsUI();

  // Guardar resultado
  saveBtnEl = createButton("Guardar imagen");
  saveBtnEl.addClass("primary-btn");
  saveBtnEl.parent(sidebar);
  saveBtnEl.elt.disabled = true;
  saveBtnEl.mousePressed(onSaveClick);

  statusDiv = createDiv("Cargando modelo de segmentación…");
  statusDiv.id("status");
  statusDiv.parent(sidebar);

  // Zona donde se muestra la foto
  const stage = createDiv().id("stage").parent(appDiv);
  const canvasFrame = createDiv().id("canvasFrame").parent(stage);
  canvasFrame.addClass("frame-empty"); // marco vacío hasta subir una foto
  canvasFrameEl = canvasFrame;

  cnv = createCanvas(640, 480); // tamaño provisional, se ajusta al subir la foto
  cnv.parent(canvasFrame);
  clearInlineCanvasSize(cnv);

  // Marcas decorativas en las esquinas
  ["tl", "tr", "bl", "br"].forEach((pos) => {
    createDiv().addClass("corner corner-" + pos).parent(canvasFrame);
  });
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
    clearInlineCanvasSize(cnv);
    canvasFrameEl.removeClass("frame-empty");

    photoReady = true;
    appState = "vacio"; // ya hay foto, falta generar el retrato
    gridLayer = null;

    updateStatus("Autorretrato cargado. escribe el poema para plasmarlo en una obra.");
    refreshGenerateButton();
    refreshSaveButton();
    redraw();
  });
}

// Solo deja plasmar el poema cuando ya hay modelo, foto y texto
function refreshGenerateButton() {
  const poemText = poemTextarea.value().trim();
  generateBtnEl.elt.disabled = !(modelReady && photoReady && poemText.length > 0);
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

// Cambia el color del poema. Si ya estaba plasmado, lo vuelve a
// dibujar al instante (sin repetir la detección de la persona).
function setTextColor(rgb) {
  CONFIG.textColor = rgb;
  updateColorButtonsUI();

  if (appState === "listo" && maskImg) {
    const poemText = poemTextarea.value().trim();
    updateStatus("Actualizando color del poema…");
    refreshSaveButton();
    buildPoemLines(poemText, () => {
      updateStatus("poema plasmado en el autorretrato.");
      refreshSaveButton();
      redraw();
    });
  }
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
function onGenerateClick() {
  if (!photoReady || !modelReady) return;

  const poemText = poemTextarea.value().trim();
  if (poemText.length === 0) return;

  generateBtnEl.elt.disabled = true;
  appState = "procesando";
  refreshSaveButton();
  updateStatus("Segmentando persona…");
  redraw();

  bodyPixModel.segment(originalImg, (err, result) => {
    if (err) {
      console.error(err);
      updateStatus("Error al segmentar. Revisa la consola del navegador.");
      refreshGenerateButton();
      return;
    }

    updateStatus("Construyendo máscara de la persona…");
    buildMask(result, () => {
      updateStatus("Acomodando el poema sobre la silueta…");
      buildPoemLines(poemText, () => {
        appState = "listo";
        updateStatus("poema plasmado en el autorretrato.");
        refreshGenerateButton();
        refreshSaveButton();
        redraw();
      });
    });
  });
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
// palabras del poema, ajustándolas al ancho disponible.
function buildPoemLines(poemText, onComplete) {
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

  gridLayer = createGraphics(w, h);
  gridLayer.clear();
  gridLayer.textFont(CONFIG.fontFamily);
  gridLayer.textSize(fontSize);
  gridLayer.textStyle(BOLD);
  gridLayer.textAlign(CENTER, CENTER);

  const spaceWidth = gridLayer.textWidth(" ");
  let wordCursor = 0;

  function fillSegment(xStart, xEnd, y) {
    const availableWidth = xEnd - xStart;
    let line = "";
    let usedWidth = 0;
    let wordsUsed = 0;
    const maxWordsPerLine = 200;

    while (wordsUsed < maxWordsPerLine) {
      const word = words[wordCursor % words.length];
      const wordWidth = gridLayer.textWidth(word);
      const extra = line.length > 0 ? spaceWidth : 0;

      if (usedWidth + extra + wordWidth > availableWidth) break;

      line += (line.length > 0 ? " " : "") + word;
      usedWidth += extra + wordWidth;
      wordCursor++;
      wordsUsed++;
    }

    if (line.length === 0) return;

    if (CONFIG.showGrid) {
      gridLayer.push();
      gridLayer.stroke(
        CONFIG.gridLineColor[0],
        CONFIG.gridLineColor[1],
        CONFIG.gridLineColor[2],
        CONFIG.gridLineAlpha
      );
      gridLayer.strokeWeight(1);
      gridLayer.line(xStart, y, xEnd, y);
      gridLayer.pop();
    }

    const cx = xStart + availableWidth / 2;
    drawLineText(line, cx, y);
  }

  const rows = [];
  for (let y = lineSpacing; y < h; y += lineSpacing) {
    rows.push(Math.floor(y));
  }

  runChunked(rows.length, 30, (i) => {
    const y = rows[i];
    const segments = scanRowSegments(maskImg, y, threshold, minSegmentWidth, maxRowGap);
    for (const [xStart, xEnd] of segments) {
      fillSegment(xStart, xEnd, y);
    }
  }, onComplete);
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
function drawLineText(line, cx, cy) {
  const isWhiteText =
    CONFIG.textColor[0] === 255 &&
    CONFIG.textColor[1] === 255 &&
    CONFIG.textColor[2] === 255;

  const shadow = isWhiteText ? SHADOW_COLOR.blanca : SHADOW_COLOR.negra;

  if (CONFIG.textOutline) {
    gridLayer.fill(shadow[0], shadow[1], shadow[2], 160);
    gridLayer.text(line, cx + 1, cy + 1);
  }
  gridLayer.fill(
    CONFIG.textColor[0],
    CONFIG.textColor[1],
    CONFIG.textColor[2],
    CONFIG.textAlpha
  );
  gridLayer.text(line, cx, cy);
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

  if (appState === "listo" && gridLayer) {
    image(gridLayer, 0, 0);
  }
}

function drawWaitingScreen() {
  background(242, 238, 215);

  if (!modelReady) {
    fill(70, 69, 65);
    textAlign(CENTER, CENTER);
    textSize(16);
    text("Cargando modelo de segmentación…", width / 2, height / 2);
    return;
  }

  fill(175, 85, 21);
  textAlign(CENTER, CENTER);
  textSize(20);

  const boxWidth = width * 0.7;
  const boxHeight = 140;
  const boxX = (width - boxWidth) / 2;
  const boxY = (height - boxHeight) / 2;

  text("Sube tu autorretrato y tu poema para plasmarlo", boxX, boxY, boxWidth, boxHeight);
}

/* ==========================================================================
   かーどメーカー アプリケーションロジック
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {

  // PWA Service Worker の登録
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .then(() => console.log('Service Worker 登録完了'))
      .catch((err) => console.error('Service Worker 登録失敗:', err));
  }

  // =========================================================================
  // 状態管理
  // =========================================================================
  let currentMode = 'draw'; // 'draw' | 'photo' | 'text'
  let penColor    = '#000000';
  let penWidth    = 20;
  let isEraser    = false;

  let isDrawing = false;
  let lastX = 0, lastY = 0;

  // Undo スタック（canvas + 写真 + テキストの統合スナップショット）
  const MAX_UNDO  = 10;
  const undoStack = [];

  // 写真操作
  let selectedImage     = null;
  let activeDragImage   = null;
  let activeResizeImage = null;
  let dragStartX = 0, dragStartY = 0;
  let imgStartX  = 0, imgStartY  = 0;
  let imgStartWidth = 0, imgStartHeight = 0;
  let imgAspectRatio = 1;
  let activeHandle = '';

  // ピンチズーム
  let isPinching           = false;
  let initialPinchDistance = 0;
  let initialPinchWidth    = 0;
  let initialPinchHeight   = 0;
  let initialPinchX        = 0;
  let initialPinchY        = 0;
  let pinchAspectRatio     = 1;

  // テキストボックス操作
  let selectedTextBox = null;

  // マルチタッチ防止
  const activePointers = new Set();

  // デバイスピクセル比
  let dpr = window.devicePixelRatio || 1;

  // =========================================================================
  // DOM 参照
  // =========================================================================
  const modeDrawBtn  = document.getElementById('mode-draw');
  const modePhotoBtn = document.getElementById('mode-photo');
  const modeTextBtn  = document.getElementById('mode-text');
  const clearBtn     = document.getElementById('clear-btn');
  const saveBtn      = document.getElementById('save-btn');

  const drawTools       = document.getElementById('draw-tools');
  const photoTools      = document.getElementById('photo-tools');
  const textTools       = document.getElementById('text-tools');

  const photoEditOptions = document.getElementById('photo-edit-options');
  const addPhotoBtn      = document.getElementById('add-photo-btn');
  const deletePhotoBtn   = document.getElementById('delete-photo-btn');
  const sendBackBtn      = document.getElementById('send-back-btn');
  const bringFrontBtn    = document.getElementById('bring-front-btn');
  const photoInput       = document.getElementById('photo-input');

  const textEditOptions = document.getElementById('text-edit-options');
  const deleteTextBtn   = document.getElementById('delete-text-btn');

  const colorBtns = document.querySelectorAll('.color-btn');
  const sizeBtns  = document.querySelectorAll('.size-btn');
  const eraserBtn = document.getElementById('eraser-btn');
  const undoBtn   = document.getElementById('undo-btn');

  const canvasContainer = document.getElementById('canvas-container');
  const photoLayer      = document.getElementById('photo-layer');
  const canvas          = document.getElementById('drawing-canvas');
  const ctx             = canvas.getContext('2d');
  const textLayer       = document.getElementById('text-layer');

  const statusIndicator = document.getElementById('status-indicator');
  const statusIcon      = document.getElementById('status-icon');
  const statusText      = document.getElementById('status-text');

  const confirmModal    = document.getElementById('confirm-modal');
  const modalCancelBtn  = document.getElementById('modal-cancel-btn');
  const modalConfirmBtn = document.getElementById('modal-confirm-btn');

  const saveToast = document.getElementById('save-toast');

  // =========================================================================
  // キャンバス初期化
  // =========================================================================
  function resizeCanvas() {
    const rect = canvasContainer.getBoundingClientRect();

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width  = canvas.width;
    tempCanvas.height = canvas.height;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.drawImage(canvas, 0, 0);

    dpr = window.devicePixelRatio || 1;
    canvas.width  = rect.width  * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width  = rect.width  + 'px';
    canvas.style.height = rect.height + 'px';

    ctx.scale(dpr, dpr);

    if (tempCanvas.width > 0 && tempCanvas.height > 0) {
      ctx.drawImage(tempCanvas, 0, 0, tempCanvas.width, tempCanvas.height,
                                0, 0, rect.width, rect.height);
    }

    setupPenProperties();
  }

  function setupPenProperties() {
    ctx.lineCap   = 'round';
    ctx.lineJoin  = 'round';
    if (isEraser) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.lineWidth   = penWidth;
      ctx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.lineWidth   = penWidth;
      ctx.strokeStyle = penColor;
    }
  }

  window.addEventListener('resize', resizeCanvas);
  setTimeout(resizeCanvas, 100);

  // =========================================================================
  // Undo（キャンバス ＋ 写真 ＋ テキストの統合スナップショット）
  // =========================================================================

  function capturePhotosState() {
    return Array.from(photoLayer.querySelectorAll('.draggable-image')).map(el => ({
      src:    el.querySelector('img').src,
      left:   parseFloat(el.style.left),
      top:    parseFloat(el.style.top),
      width:  parseFloat(el.style.width),
      height: parseFloat(el.style.height),
    }));
  }

  function captureTextState() {
    return Array.from(textLayer.querySelectorAll('.text-box')).map(box => ({
      html: box.querySelector('.text-content').innerHTML,
      left: box.style.left,
      top:  box.style.top,
    }));
  }

  function saveStateForUndo() {
    if (undoStack.length >= MAX_UNDO) undoStack.shift();
    undoStack.push({
      canvasDataUrl: canvas.toDataURL(),
      photos: capturePhotosState(),
      texts:  captureTextState(),
    });
    updateUndoBtn();
  }

  function performUndo() {
    if (undoStack.length === 0) return;
    const snap = undoStack.pop();

    // キャンバス復元
    const img = new Image();
    img.onload = () => {
      const rect = canvasContainer.getBoundingClientRect();
      ctx.clearRect(0, 0, rect.width, rect.height);
      ctx.drawImage(img, 0, 0, rect.width, rect.height);
      setupPenProperties();
    };
    img.src = snap.canvasDataUrl;

    // 写真復元
    deselectAllImages();
    photoLayer.innerHTML = '';
    snap.photos.forEach(p => {
      const wrapper = document.createElement('div');
      wrapper.className = 'draggable-image';
      const imgEl = document.createElement('img');
      imgEl.src = p.src;
      wrapper.appendChild(imgEl);
      ['tl', 'tr', 'bl', 'br'].forEach(pos => {
        const handle = document.createElement('div');
        handle.className = `resize-handle ${pos}`;
        handle.setAttribute('data-handle', pos);
        wrapper.appendChild(handle);
      });
      wrapper.style.left   = p.left   + 'px';
      wrapper.style.top    = p.top    + 'px';
      wrapper.style.width  = p.width  + 'px';
      wrapper.style.height = p.height + 'px';
      photoLayer.appendChild(wrapper);
      setupImageEvents(wrapper);
    });

    // テキスト復元
    deselectAllTextBoxes();
    textLayer.innerHTML = '';
    snap.texts.forEach(t => {
      const box = buildTextBoxElement(t.html, t.left, t.top);
      textLayer.appendChild(box);
      setupTextBoxEvents(box);
    });

    updateUndoBtn();
  }

  function updateUndoBtn() {
    undoBtn.disabled = undoStack.length === 0;
  }

  updateUndoBtn();

  // =========================================================================
  // モード切り替え
  // =========================================================================
  function switchMode(mode) {
    currentMode = mode;

    // モードボタンのアクティブ状態
    modeDrawBtn.classList.toggle('active', mode === 'draw');
    modePhotoBtn.classList.toggle('active', mode === 'photo');
    modeTextBtn.classList.toggle('active', mode === 'text');

    // ツールグループの表示切り替え
    drawTools.classList.toggle('hidden', mode !== 'draw');
    photoTools.classList.toggle('hidden', mode !== 'photo');
    textTools.classList.toggle('hidden', mode !== 'text');

    // キャンバスのポインターイベント
    canvas.style.pointerEvents = mode === 'draw' ? 'auto' : 'none';

    // テキストレイヤーのインタラクション（文字モード時のみ有効）
    textLayer.classList.toggle('interactive', mode === 'text');

    if (mode === 'draw') {
      deselectAllImages();
      deselectAllTextBoxes();
      updateStatusDraw();
    } else if (mode === 'photo') {
      deselectAllTextBoxes();
      statusIndicator.className = 'photo-mode';
      statusIcon.textContent = '📷';
      statusText.textContent = 'しゃしん モード';
    } else {
      deselectAllImages();
      statusIndicator.className = 'text-mode';
      statusIcon.textContent = '📝';
      statusText.textContent = '文字 モード';
    }
  }

  function updateStatusDraw() {
    statusIndicator.className = isEraser ? 'draw-mode eraser-active' : 'draw-mode';
    statusIcon.textContent = isEraser ? '🩹' : '✏️';
    statusText.textContent = isEraser ? 'けしゴム モード' : 'おえかき モード';
  }

  modeDrawBtn.addEventListener('click',  () => switchMode('draw'));
  modePhotoBtn.addEventListener('click', () => switchMode('photo'));
  modeTextBtn.addEventListener('click',  () => switchMode('text'));

  // =========================================================================
  // お絵かき（描画）ロジック
  // =========================================================================
  function getCoordinates(e) {
    const rect = canvas.getBoundingClientRect();
    let clientX, clientY;
    if (e.touches && e.touches.length > 0) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (currentMode !== 'draw') return;

    activePointers.add(e.pointerId);
    if (activePointers.size > 1) {
      isDrawing = false;
      return;
    }

    e.preventDefault();

    // 消しゴムモード時：テキストボックスの範囲内なら削除してキャンバス描画をスキップ
    if (isEraser) {
      const coords = getCoordinates(e);
      const canvasRect = canvas.getBoundingClientRect();
      const boxes = Array.from(textLayer.querySelectorAll('.text-box'));
      for (const box of boxes) {
        const br = box.getBoundingClientRect();
        if (coords.x >= br.left - canvasRect.left &&
            coords.x <= br.right  - canvasRect.left &&
            coords.y >= br.top    - canvasRect.top &&
            coords.y <= br.bottom - canvasRect.top) {
          saveStateForUndo();
          box.remove();
          deselectAllTextBoxes();
          activePointers.delete(e.pointerId);
          return;
        }
      }
    }

    saveStateForUndo();
    isDrawing = true;
    const coords = getCoordinates(e);
    lastX = coords.x;
    lastY = coords.y;

    setupPenProperties();

    // タップだけでも点を描く
    ctx.beginPath();
    ctx.arc(lastX, lastY, penWidth / 2, 0, Math.PI * 2);
    if (isEraser) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = 'rgba(0,0,0,1)';
    } else {
      ctx.fillStyle = penColor;
    }
    ctx.fill();
    ctx.beginPath();

    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!isDrawing || currentMode !== 'draw') return;
    if (activePointers.size > 1) return;

    const coords = getCoordinates(e);
    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(coords.x, coords.y);
    ctx.stroke();
    lastX = coords.x;
    lastY = coords.y;

    e.preventDefault();
  });

  canvas.addEventListener('pointerup',     (e) => { activePointers.delete(e.pointerId); isDrawing = false; });
  canvas.addEventListener('pointercancel', (e) => { activePointers.delete(e.pointerId); isDrawing = false; });
  canvas.addEventListener('pointerleave',  ()  => { isDrawing = false; });

  // --- いろ ---
  colorBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      colorBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      penColor = btn.getAttribute('data-color');
      if (isEraser) setEraserMode(false);
      else setupPenProperties();
    });
  });

  // --- ふとさ ---
  sizeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      sizeBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      penWidth = parseInt(btn.getAttribute('data-size'), 10);
      setupPenProperties();
    });
  });

  // --- 消しゴム ---
  function setEraserMode(active) {
    isEraser = active;
    eraserBtn.classList.toggle('active', active);
    canvas.classList.toggle('eraser-cursor', active);
    document.querySelector('.color-palette').classList.toggle('eraser-active', active);
    setupPenProperties();
    updateStatusDraw();
  }

  eraserBtn.addEventListener('click', () => setEraserMode(!isEraser));

  // --- もどす ---
  undoBtn.addEventListener('click', performUndo);

  // =========================================================================
  // しゃしん（画像操作）ロジック
  // =========================================================================

  addPhotoBtn.addEventListener('click', () => photoInput.click());

  photoInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    saveStateForUndo();
    const reader = new FileReader();
    reader.onload = (ev) => createDraggableImage(ev.target.result);
    reader.readAsDataURL(file);
    photoInput.value = '';
  });

  function createDraggableImage(src) {
    const wrapper = document.createElement('div');
    wrapper.className = 'draggable-image';

    const img = document.createElement('img');
    img.src = src;
    wrapper.appendChild(img);

    ['tl', 'tr', 'bl', 'br'].forEach(pos => {
      const handle = document.createElement('div');
      handle.className = `resize-handle ${pos}`;
      handle.setAttribute('data-handle', pos);
      wrapper.appendChild(handle);
    });

    photoLayer.appendChild(wrapper);

    img.onload = () => {
      const containerRect = canvasContainer.getBoundingClientRect();
      const ratio = (img.naturalWidth || 250) / (img.naturalHeight || 250);
      let initWidth  = Math.min(containerRect.width * 0.35, 280);
      let initHeight = initWidth / ratio;
      wrapper.style.width  = initWidth  + 'px';
      wrapper.style.height = initHeight + 'px';
      wrapper.style.left   = ((containerRect.width  - initWidth)  / 2 + (Math.random() * 40 - 20)) + 'px';
      wrapper.style.top    = ((containerRect.height - initHeight) / 2 + (Math.random() * 40 - 20)) + 'px';
      selectImage(wrapper);
    };

    setupImageEvents(wrapper);
  }

  function selectImage(el) {
    deselectAllImages();
    selectedImage = el;
    el.classList.add('selected');
    photoEditOptions.classList.remove('hidden');
  }

  function deselectAllImages() {
    photoLayer.querySelectorAll('.draggable-image.selected')
      .forEach(el => el.classList.remove('selected'));
    selectedImage = null;
    photoEditOptions.classList.add('hidden');
  }

  canvasContainer.addEventListener('pointerdown', (e) => {
    if (currentMode !== 'photo') return;
    if (!e.target.closest('.draggable-image')) deselectAllImages();
  });

  deletePhotoBtn.addEventListener('click', () => {
    if (!selectedImage) return;
    saveStateForUndo();
    selectedImage.remove();
    deselectAllImages();
  });

  // 写真の重なり順：1枚ずつ前後に移動
  bringFrontBtn.addEventListener('click', () => {
    if (!selectedImage) return;
    saveStateForUndo();
    const next = selectedImage.nextElementSibling;
    if (next && next.classList.contains('draggable-image')) {
      // next を selectedImage の直前に挿入 → selectedImage が1枚前に出る
      photoLayer.insertBefore(next, selectedImage);
    }
  });

  sendBackBtn.addEventListener('click', () => {
    if (!selectedImage) return;
    saveStateForUndo();
    const prev = selectedImage.previousElementSibling;
    if (prev && prev.classList.contains('draggable-image')) {
      // selectedImage を prev の直前に挿入 → 1枚後ろへ
      photoLayer.insertBefore(selectedImage, prev);
    }
  });

  // 画像ごとのドラッグ・リサイズ・ピンチ
  function setupImageEvents(el) {

    let savedForThisInteraction = false;
    let savedForThisPinch       = false;

    el.addEventListener('pointerdown', (e) => {
      if (currentMode !== 'photo') return;
      e.stopPropagation();
      savedForThisInteraction = false;

      const handleEl = e.target.closest('.resize-handle');
      if (handleEl) {
        activeResizeImage = el;
        activeHandle = handleEl.getAttribute('data-handle');
        const rect          = el.getBoundingClientRect();
        const containerRect = canvasContainer.getBoundingClientRect();
        imgStartX      = rect.left - containerRect.left;
        imgStartY      = rect.top  - containerRect.top;
        imgStartWidth  = rect.width;
        imgStartHeight = rect.height;
        imgAspectRatio = imgStartWidth / imgStartHeight;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        el.setPointerCapture(e.pointerId);
        return;
      }

      selectImage(el);
      activeDragImage = el;
      const rect          = el.getBoundingClientRect();
      const containerRect = canvasContainer.getBoundingClientRect();
      imgStartX  = rect.left - containerRect.left;
      imgStartY  = rect.top  - containerRect.top;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      photoLayer.appendChild(el);
      el.setPointerCapture(e.pointerId);
    });

    el.addEventListener('pointermove', (e) => {
      if (isPinching) return;

      if (activeResizeImage === el) {
        if (!savedForThisInteraction) { saveStateForUndo(); savedForThisInteraction = true; }
        e.stopPropagation();

        const dx = e.clientX - dragStartX;
        let newWidth = imgStartWidth, newHeight = imgStartHeight;
        let newLeft = imgStartX, newTop = imgStartY;

        if (activeHandle === 'br') {
          newWidth  = Math.max(50, imgStartWidth + dx);
          newHeight = newWidth / imgAspectRatio;
        } else if (activeHandle === 'bl') {
          newWidth  = Math.max(50, imgStartWidth - dx);
          newHeight = newWidth / imgAspectRatio;
          newLeft   = imgStartX + (imgStartWidth - newWidth);
        } else if (activeHandle === 'tr') {
          newWidth  = Math.max(50, imgStartWidth + dx);
          newHeight = newWidth / imgAspectRatio;
          newTop    = imgStartY + (imgStartHeight - newHeight);
        } else if (activeHandle === 'tl') {
          newWidth  = Math.max(50, imgStartWidth - dx);
          newHeight = newWidth / imgAspectRatio;
          newLeft   = imgStartX + (imgStartWidth - newWidth);
          newTop    = imgStartY + (imgStartHeight - newHeight);
        }

        el.style.width  = newWidth  + 'px';
        el.style.height = newHeight + 'px';
        el.style.left   = newLeft   + 'px';
        el.style.top    = newTop    + 'px';
        return;
      }

      if (activeDragImage === el) {
        if (!savedForThisInteraction) { saveStateForUndo(); savedForThisInteraction = true; }
        e.stopPropagation();

        const dx = e.clientX - dragStartX;
        const dy = e.clientY - dragStartY;
        const containerRect = canvasContainer.getBoundingClientRect();
        const imgW = el.offsetWidth, imgH = el.offsetHeight;

        el.style.left = Math.max(-imgW + 40, Math.min(containerRect.width  - 40, imgStartX + dx)) + 'px';
        el.style.top  = Math.max(-imgH + 40, Math.min(containerRect.height - 40, imgStartY + dy)) + 'px';
      }
    });

    const stopDragResize = (e) => {
      if (activeDragImage   === el) { activeDragImage   = null; el.releasePointerCapture(e.pointerId); }
      if (activeResizeImage === el) { activeResizeImage = null; el.releasePointerCapture(e.pointerId); }
    };
    el.addEventListener('pointerup',     stopDragResize);
    el.addEventListener('pointercancel', stopDragResize);

    // ピンチ
    el.addEventListener('touchstart', (e) => {
      if (currentMode !== 'photo') return;
      if (e.touches.length === 2) {
        e.stopPropagation();
        savedForThisPinch = false;
        isPinching = true;
        selectImage(el);
        const t1 = e.touches[0], t2 = e.touches[1];
        initialPinchDistance = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
        const rect          = el.getBoundingClientRect();
        const containerRect = canvasContainer.getBoundingClientRect();
        initialPinchWidth  = rect.width;
        initialPinchHeight = rect.height;
        initialPinchX      = rect.left - containerRect.left;
        initialPinchY      = rect.top  - containerRect.top;
        pinchAspectRatio   = initialPinchWidth / initialPinchHeight;
      }
    }, { passive: false });

    el.addEventListener('touchmove', (e) => {
      if (currentMode !== 'photo' || !isPinching || e.touches.length !== 2) return;
      e.stopPropagation();
      e.preventDefault();

      if (!savedForThisPinch) { saveStateForUndo(); savedForThisPinch = true; }

      const t1 = e.touches[0], t2 = e.touches[1];
      const currentDistance = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
      if (initialPinchDistance <= 0) return;

      const scale = currentDistance / initialPinchDistance;
      const containerRect = canvasContainer.getBoundingClientRect();
      const newWidth  = Math.max(50, Math.min(containerRect.width * 1.5, initialPinchWidth  * scale));
      const newHeight = newWidth / pinchAspectRatio;
      const dw = newWidth  - initialPinchWidth;
      const dh = newHeight - initialPinchHeight;

      el.style.width  = newWidth  + 'px';
      el.style.height = newHeight + 'px';
      el.style.left   = (initialPinchX - dw / 2) + 'px';
      el.style.top    = (initialPinchY - dh / 2) + 'px';
    }, { passive: false });

    el.addEventListener('touchend', (e) => {
      if (isPinching && e.touches.length < 2) {
        isPinching = false;
        initialPinchDistance = 0;
      }
    });
  }

  // =========================================================================
  // テキストボックス（文字モード）ロジック
  // =========================================================================

  // テキストボックスの DOM 要素を生成して返す（appendChild と setupTextBoxEvents は呼び出し元で行う）
  function buildTextBoxElement(html, left, top) {
    const box = document.createElement('div');
    box.className = 'text-box';
    box.style.left = left;
    box.style.top  = top;

    const handle = document.createElement('div');
    handle.className = 'text-drag-handle';
    handle.textContent = '≡ うごかす';
    box.appendChild(handle);

    const content = document.createElement('div');
    content.className = 'text-content';
    content.contentEditable = 'true';
    content.spellcheck = false;
    content.innerHTML = html;
    box.appendChild(content);

    return box;
  }

  // キャンバス上の指定位置に新しいテキストボックスを作成する
  function createTextBox(x, y) {
    const containerRect = canvasContainer.getBoundingClientRect();
    const left = Math.max(4, Math.min(containerRect.width  - 110, x - 45)) + 'px';
    const top  = Math.max(0, Math.min(containerRect.height - 80,  y - 16)) + 'px';

    const box = buildTextBoxElement('', left, top);
    textLayer.appendChild(box);
    setupTextBoxEvents(box);
    selectTextBox(box);

    // 少し待ってからフォーカス（iOS でキーボードが確実に開く）
    setTimeout(() => box.querySelector('.text-content').focus(), 80);
  }

  // テキストボックスの選択
  function selectTextBox(box) {
    deselectAllTextBoxes();
    selectedTextBox = box;
    box.classList.add('selected');
    textEditOptions.classList.remove('hidden');
  }

  function deselectAllTextBoxes() {
    textLayer.querySelectorAll('.text-box.selected').forEach(el => el.classList.remove('selected'));
    selectedTextBox = null;
    textEditOptions.classList.add('hidden');
  }

  // 文字モード：キャンバスタップで新しいテキストボックスを作成
  textLayer.addEventListener('pointerdown', (e) => {
    if (currentMode !== 'text') return;

    // 既存のテキストボックスをタップした場合はそちらで処理
    if (e.target.closest('.text-box')) return;

    // 別のテキストボックスが編集中なら、まずキーボードを閉じる
    const focused = document.activeElement;
    if (focused && focused.classList.contains('text-content')) {
      focused.blur();
      deselectAllTextBoxes();
      return;
    }

    saveStateForUndo();
    const rect = textLayer.getBoundingClientRect();
    createTextBox(e.clientX - rect.left, e.clientY - rect.top);
  });

  // テキストボックスの削除ボタン
  deleteTextBtn.addEventListener('click', () => {
    if (!selectedTextBox) return;
    saveStateForUndo();
    selectedTextBox.remove();
    deselectAllTextBoxes();
  });

  // 各テキストボックスのドラッグ・選択イベント
  function setupTextBoxEvents(box) {
    const handle  = box.querySelector('.text-drag-handle');
    const content = box.querySelector('.text-content');

    let isDragging        = false;
    let txtDragStartX     = 0, txtDragStartY = 0;
    let txtInitX          = 0, txtInitY       = 0;
    let savedForThisDrag  = false;

    // テキストボックス全体のタップ → 選択
    box.addEventListener('pointerdown', (e) => {
      if (currentMode !== 'text') return;
      e.stopPropagation();
      selectTextBox(box);
    });

    // ドラッグハンドルで移動
    handle.addEventListener('pointerdown', (e) => {
      if (currentMode !== 'text') return;
      e.stopPropagation();
      e.preventDefault();

      savedForThisDrag = false;
      isDragging    = true;
      txtDragStartX = e.clientX;
      txtDragStartY = e.clientY;
      txtInitX      = parseFloat(box.style.left) || 0;
      txtInitY      = parseFloat(box.style.top)  || 0;

      handle.setPointerCapture(e.pointerId);
    });

    handle.addEventListener('pointermove', (e) => {
      if (!isDragging) return;

      if (!savedForThisDrag) { saveStateForUndo(); savedForThisDrag = true; }

      const dx = e.clientX - txtDragStartX;
      const dy = e.clientY - txtDragStartY;
      const containerRect = canvasContainer.getBoundingClientRect();

      box.style.left = Math.max(0, Math.min(containerRect.width  - 50, txtInitX + dx)) + 'px';
      box.style.top  = Math.max(0, Math.min(containerRect.height - 40, txtInitY + dy)) + 'px';
    });

    const stopTextDrag = () => { isDragging = false; };
    handle.addEventListener('pointerup',     stopTextDrag);
    handle.addEventListener('pointercancel', stopTextDrag);

    // テキスト入力エリア：フォーカス時に選択
    content.addEventListener('focus', () => {
      if (currentMode === 'text') selectTextBox(box);
    });
  }

  // =========================================================================
  // 全消去（リセット）
  // =========================================================================
  clearBtn.addEventListener('click', () => {
    confirmModal.classList.remove('hidden');
  });

  modalCancelBtn.addEventListener('click', () => {
    confirmModal.classList.add('hidden');
  });

  modalConfirmBtn.addEventListener('click', () => {
    saveStateForUndo();
    const rect = canvasContainer.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    photoLayer.innerHTML = '';
    textLayer.innerHTML  = '';
    deselectAllImages();
    deselectAllTextBoxes();
    confirmModal.classList.add('hidden');
  });

  // =========================================================================
  // 保存（できた！）
  // =========================================================================
  saveBtn.addEventListener('click', () => {
    deselectAllImages();
    deselectAllTextBoxes();
    setTimeout(exportCardAsPNG, 150);
  });

  async function exportCardAsPNG() {
    // フォントが確実にロードされてから書き出す
    await document.fonts.ready;

    const containerRect = canvasContainer.getBoundingClientRect();
    const exportDpr = window.devicePixelRatio || 1;

    const exportCanvas = document.createElement('canvas');
    exportCanvas.width  = containerRect.width  * exportDpr;
    exportCanvas.height = containerRect.height * exportDpr;
    const exportCtx = exportCanvas.getContext('2d');
    exportCtx.scale(exportDpr, exportDpr);

    // 1. 白背景
    exportCtx.fillStyle = '#ffffff';
    exportCtx.fillRect(0, 0, containerRect.width, containerRect.height);

    // 2. 写真レイヤーを DOM 順に描画
    const drawTasks = Array.from(photoLayer.querySelectorAll('.draggable-image')).map(wrapper =>
      new Promise((resolve) => {
        const img    = wrapper.querySelector('img');
        const left   = parseFloat(wrapper.style.left);
        const top    = parseFloat(wrapper.style.top);
        const width  = parseFloat(wrapper.style.width);
        const height = parseFloat(wrapper.style.height);
        const ei = new Image();
        ei.onload  = () => resolve({ img: ei, left, top, width, height });
        ei.onerror = () => resolve(null);
        ei.src = img.src;
      })
    );
    const results = await Promise.all(drawTasks);
    results.forEach(item => {
      if (item) exportCtx.drawImage(item.img, item.left, item.top, item.width, item.height);
    });

    // 3. 手書きキャンバスを合成
    exportCtx.drawImage(canvas, 0, 0, containerRect.width, containerRect.height);

    // 4. テキストボックスを描画
    const canvasRect = canvas.getBoundingClientRect();
    textLayer.querySelectorAll('.text-box').forEach(box => {
      const content = box.querySelector('.text-content');
      const text = (content.innerText || '').trim();
      if (!text) return;

      const br     = box.getBoundingClientRect();
      const bLeft  = br.left - canvasRect.left;
      const bTop   = br.top  - canvasRect.top;
      const bWidth = br.width;
      const bHeight = br.height;

      // 背景
      exportCtx.fillStyle = 'rgba(255, 255, 255, 0.96)';
      exportCtx.beginPath();
      if (exportCtx.roundRect) {
        exportCtx.roundRect(bLeft, bTop, bWidth, bHeight, 10);
      } else {
        exportCtx.rect(bLeft, bTop, bWidth, bHeight);
      }
      exportCtx.fill();

      // テキスト（ドラッグハンドル分を除いた位置から描く）
      const handleHeight = box.querySelector('.text-drag-handle').getBoundingClientRect().height;
      const fontSize = 32;
      const paddingLeft = 14;
      const paddingTop  = 8;
      exportCtx.font = `900 ${fontSize}px 'Zen Maru Gothic', sans-serif`;
      exportCtx.fillStyle = '#1a1a1a';
      exportCtx.textBaseline = 'top';

      text.split('\n').forEach((line, i) => {
        exportCtx.fillText(
          line,
          bLeft + paddingLeft,
          bTop + handleHeight + paddingTop + i * (fontSize * 1.35)
        );
      });
    });

    // 5. ダウンロード / 共有
    try {
      const dataUrl = exportCanvas.toDataURL('image/png');
      const now = new Date();
      const dateStr =
        now.getFullYear() +
        String(now.getMonth() + 1).padStart(2, '0') +
        String(now.getDate()).padStart(2, '0') + '_' +
        String(now.getHours()).padStart(2, '0') +
        String(now.getMinutes()).padStart(2, '0') +
        String(now.getSeconds()).padStart(2, '0');
      const filename = `かーどメーカー_${dateStr}.png`;

      if (navigator.share && navigator.canShare) {
        try {
          const blob = await fetch(dataUrl).then(r => r.blob());
          const file = new File([blob], filename, { type: 'image/png' });
          if (navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: 'かーどメーカー' });
            showSaveToast();
            return;
          }
        } catch (shareErr) {
          if (shareErr.name === 'AbortError') return;
        }
      }

      const link = document.createElement('a');
      link.download = filename;
      link.href = dataUrl;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      showSaveToast();

    } catch (err) {
      console.error('保存失敗:', err);
      alert('ほぞんに しっぱいしちゃった。ごめんね。');
    }
  }

  function showSaveToast() {
    saveToast.classList.remove('hidden');
    requestAnimationFrame(() => requestAnimationFrame(() => saveToast.classList.add('show')));
    setTimeout(() => {
      saveToast.classList.remove('show');
      setTimeout(() => saveToast.classList.add('hidden'), 350);
    }, 2500);
  }

});

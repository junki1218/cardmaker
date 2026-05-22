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
  let currentMode = 'draw'; // 'draw' | 'photo'
  let penColor   = '#000000';
  let penWidth   = 20;
  let isEraser   = false;

  // 描画
  let isDrawing = false;
  let lastX = 0, lastY = 0;

  // undo スタック（canvas の DataURL を保持、最大 MAX_UNDO ステップ）
  const MAX_UNDO  = 20;
  const undoStack = [];

  // 画像操作
  let selectedImage    = null;
  let activeDragImage  = null;
  let activeResizeImage = null;

  // ドラッグ / リサイズ用の一時保持
  let dragStartX = 0, dragStartY = 0;
  let imgStartX  = 0, imgStartY  = 0;
  let imgStartWidth = 0, imgStartHeight = 0;
  let imgAspectRatio = 1;   // 対象画像ごとのアスペクト比
  let activeHandle = '';    // 'tl'|'tr'|'bl'|'br'

  // ピンチズーム用
  let isPinching           = false;
  let initialPinchDistance = 0;
  let initialPinchWidth    = 0;
  let initialPinchHeight   = 0;
  let initialPinchX        = 0;
  let initialPinchY        = 0;
  let pinchAspectRatio     = 1; // ピンチ開始時に固定するアスペクト比

  // マルチタッチ防止（PointerID を追跡）
  const activePointers = new Set();

  // デバイスピクセル比（resizeCanvas 内で更新）
  let dpr = window.devicePixelRatio || 1;

  // =========================================================================
  // DOM 参照
  // =========================================================================
  const modeDrawBtn  = document.getElementById('mode-draw');
  const modePhotoBtn = document.getElementById('mode-photo');
  const clearBtn     = document.getElementById('clear-btn');
  const saveBtn      = document.getElementById('save-btn');

  const drawTools       = document.getElementById('draw-tools');
  const photoTools      = document.getElementById('photo-tools');
  const photoEditOptions = document.getElementById('photo-edit-options');
  const addPhotoBtn     = document.getElementById('add-photo-btn');
  const deletePhotoBtn  = document.getElementById('delete-photo-btn');
  const sendBackBtn     = document.getElementById('send-back-btn');
  const bringFrontBtn   = document.getElementById('bring-front-btn');
  const photoInput      = document.getElementById('photo-input');

  const colorBtns  = document.querySelectorAll('.color-btn');
  const sizeBtns   = document.querySelectorAll('.size-btn');
  const eraserBtn  = document.getElementById('eraser-btn');
  const undoBtn    = document.getElementById('undo-btn');

  const canvasContainer = document.getElementById('canvas-container');
  const photoLayer      = document.getElementById('photo-layer');
  const canvas          = document.getElementById('drawing-canvas');
  const ctx             = canvas.getContext('2d');

  const statusIndicator = document.getElementById('status-indicator');
  const statusIcon      = document.getElementById('status-icon');
  const statusText      = document.getElementById('status-text');

  const confirmModal   = document.getElementById('confirm-modal');
  const modalCancelBtn = document.getElementById('modal-cancel-btn');
  const modalConfirmBtn = document.getElementById('modal-confirm-btn');

  const saveToast = document.getElementById('save-toast');

  // =========================================================================
  // キャンバス初期化
  // =========================================================================
  function resizeCanvas() {
    const rect = canvasContainer.getBoundingClientRect();

    // 現在の描画内容を一時保存
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

    // 元の描画内容を復元（canvas.width リセットで変換行列もリセットされるため安全）
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
      ctx.lineWidth  = penWidth;
      ctx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.lineWidth  = penWidth;
      ctx.strokeStyle = penColor;
    }
  }

  window.addEventListener('resize', resizeCanvas);
  setTimeout(resizeCanvas, 100);

  // =========================================================================
  // Undo ユーティリティ
  // =========================================================================
  function saveStateForUndo() {
    if (undoStack.length >= MAX_UNDO) undoStack.shift();
    undoStack.push(canvas.toDataURL());
    updateUndoBtn();
  }

  function performUndo() {
    if (undoStack.length === 0) return;
    const prevDataUrl = undoStack.pop();
    const img = new Image();
    img.onload = () => {
      const rect = canvasContainer.getBoundingClientRect();
      ctx.clearRect(0, 0, rect.width, rect.height);
      ctx.drawImage(img, 0, 0, rect.width, rect.height);
      setupPenProperties();
    };
    img.src = prevDataUrl;
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

    if (mode === 'draw') {
      modeDrawBtn.classList.add('active');
      modePhotoBtn.classList.remove('active');
      drawTools.classList.remove('hidden');
      photoTools.classList.add('hidden');

      canvas.style.pointerEvents = 'auto';
      deselectAllImages();

      updateStatusDraw();
    } else {
      modeDrawBtn.classList.remove('active');
      modePhotoBtn.classList.add('active');
      drawTools.classList.add('hidden');
      photoTools.classList.remove('hidden');

      // キャンバスを透過して下の画像を操作できるように
      canvas.style.pointerEvents = 'none';

      statusIndicator.className = 'photo-mode';
      statusIcon.textContent = '📷';
      statusText.textContent = 'しゃしん モード（しゃしんを うごかせるよ）';
    }
  }

  function updateStatusDraw() {
    statusIndicator.className = isEraser
      ? 'draw-mode eraser-active'
      : 'draw-mode';
    statusIcon.textContent = isEraser ? '🩹' : '✏️';
    statusText.textContent = isEraser
      ? 'けしゴム モード（けせるよ）'
      : 'おえかき モード（えのぐで かけるよ）';
  }

  modeDrawBtn.addEventListener('click',  () => switchMode('draw'));
  modePhotoBtn.addEventListener('click', () => switchMode('photo'));

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

  // --- PointerID を使ったマルチタッチ防止 ---
  canvas.addEventListener('pointerdown', (e) => {
    if (currentMode !== 'draw') return;

    activePointers.add(e.pointerId);

    // 2本指以上のタッチは描画しない
    if (activePointers.size > 1) {
      isDrawing = false;
      return;
    }

    e.preventDefault();

    // Undo 用に描画前の状態を保存
    saveStateForUndo();

    isDrawing = true;
    const coords = getCoordinates(e);
    lastX = coords.x;
    lastY = coords.y;

    setupPenProperties();

    // タップだけでも点を描画
    ctx.beginPath();
    ctx.arc(lastX, lastY, penWidth / 2, 0, Math.PI * 2);
    if (isEraser) {
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
    if (activePointers.size > 1) return; // マルチタッチ中は描かない

    const coords = getCoordinates(e);
    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(coords.x, coords.y);
    ctx.stroke();
    lastX = coords.x;
    lastY = coords.y;

    e.preventDefault();
  });

  canvas.addEventListener('pointerup', (e) => {
    activePointers.delete(e.pointerId);
    isDrawing = false;
  });

  canvas.addEventListener('pointercancel', (e) => {
    activePointers.delete(e.pointerId);
    isDrawing = false;
  });

  canvas.addEventListener('pointerleave', () => {
    isDrawing = false;
  });

  // --- いろの選択 ---
  colorBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      colorBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      penColor = btn.getAttribute('data-color');

      // 色を選んだら自動的にペンモードに戻る
      if (isEraser) {
        setEraserMode(false);
      } else {
        setupPenProperties();
      }
    });
  });

  // --- ふとさの選択 ---
  sizeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      sizeBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      penWidth = parseInt(btn.getAttribute('data-size'), 10);
      setupPenProperties();
    });
  });

  // --- 消しゴムボタン ---
  function setEraserMode(active) {
    isEraser = active;
    eraserBtn.classList.toggle('active', active);
    canvas.classList.toggle('eraser-cursor', active);

    // 色パレットの見た目をアップデート
    const colorPalette = document.querySelector('.color-palette');
    colorPalette.classList.toggle('eraser-active', active);

    setupPenProperties();
    updateStatusDraw();
  }

  eraserBtn.addEventListener('click', () => {
    setEraserMode(!isEraser);
  });

  // --- 元に戻す ---
  undoBtn.addEventListener('click', () => {
    performUndo();
  });

  // =========================================================================
  // しゃしん（画像操作）ロジック
  // =========================================================================

  addPhotoBtn.addEventListener('click', () => {
    photoInput.click();
  });

  photoInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => createDraggableImage(ev.target.result);
    reader.readAsDataURL(file);

    // 同じファイルを連続して選べるようにリセット
    photoInput.value = '';
  });

  // --- 画像要素の生成 ---
  function createDraggableImage(src) {
    const wrapper = document.createElement('div');
    wrapper.className = 'draggable-image';

    const img = document.createElement('img');
    img.src = src;
    wrapper.appendChild(img);

    // 四隅ハンドル
    ['tl', 'tr', 'bl', 'br'].forEach(pos => {
      const handle = document.createElement('div');
      handle.className = `resize-handle ${pos}`;
      handle.setAttribute('data-handle', pos);
      wrapper.appendChild(handle);
    });

    photoLayer.appendChild(wrapper);

    img.onload = () => {
      const containerRect = canvasContainer.getBoundingClientRect();
      const w = img.naturalWidth  || 250;
      const h = img.naturalHeight || 250;
      const ratio = w / h;

      let initWidth  = Math.min(containerRect.width * 0.35, 280);
      let initHeight = initWidth / ratio;

      const initLeft = (containerRect.width  - initWidth)  / 2 + (Math.random() * 40 - 20);
      const initTop  = (containerRect.height - initHeight) / 2 + (Math.random() * 40 - 20);

      wrapper.style.width  = initWidth  + 'px';
      wrapper.style.height = initHeight + 'px';
      wrapper.style.left   = initLeft   + 'px';
      wrapper.style.top    = initTop    + 'px';

      selectImage(wrapper);
    };

    setupImageEvents(wrapper);
  }

  // --- 選択 / 選択解除 ---
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

  // キャンバス背景タップで選択解除（しゃしんモード時）
  canvasContainer.addEventListener('pointerdown', (e) => {
    if (currentMode !== 'photo') return;
    if (!e.target.closest('.draggable-image')) {
      deselectAllImages();
    }
  });

  // --- 削除 ---
  deletePhotoBtn.addEventListener('click', () => {
    if (selectedImage) {
      selectedImage.remove();
      deselectAllImages();
    }
  });

  // --- 前面 / 後面 ---
  bringFrontBtn.addEventListener('click', () => {
    if (!selectedImage) return;
    photoLayer.appendChild(selectedImage); // DOM最後 = 最前面
  });

  sendBackBtn.addEventListener('click', () => {
    if (!selectedImage) return;
    photoLayer.insertBefore(selectedImage, photoLayer.firstChild); // DOM先頭 = 最背面
  });

  // --- 画像個別のイベント（ドラッグ・リサイズ・ピンチ）---
  function setupImageEvents(el) {

    // ----- PointerEvents: ドラッグ & ハンドルリサイズ -----
    el.addEventListener('pointerdown', (e) => {
      if (currentMode !== 'photo') return;
      e.stopPropagation();

      const handleEl = e.target.closest('.resize-handle');
      if (handleEl) {
        // リサイズ開始
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

      // 通常のドラッグ開始
      selectImage(el);
      activeDragImage = el;

      const rect          = el.getBoundingClientRect();
      const containerRect = canvasContainer.getBoundingClientRect();

      imgStartX = rect.left - containerRect.left;
      imgStartY = rect.top  - containerRect.top;

      dragStartX = e.clientX;
      dragStartY = e.clientY;

      // 操作中の画像を最前面へ
      photoLayer.appendChild(el);

      el.setPointerCapture(e.pointerId);
    });

    el.addEventListener('pointermove', (e) => {
      if (isPinching) return; // ピンチ中はポインタ処理を無効化

      // リサイズ
      if (activeResizeImage === el) {
        e.stopPropagation();

        const dx = e.clientX - dragStartX;
        const dy = e.clientY - dragStartY;

        let newWidth  = imgStartWidth;
        let newHeight = imgStartHeight;
        let newLeft   = imgStartX;
        let newTop    = imgStartY;

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

      // ドラッグ移動
      if (activeDragImage === el) {
        e.stopPropagation();

        const dx = e.clientX - dragStartX;
        const dy = e.clientY - dragStartY;

        let targetLeft = imgStartX + dx;
        let targetTop  = imgStartY + dy;

        const containerRect = canvasContainer.getBoundingClientRect();
        const imgW = el.offsetWidth;
        const imgH = el.offsetHeight;

        // 画像が完全に消えないように端に余白を持たせる
        targetLeft = Math.max(-imgW + 40, Math.min(containerRect.width  - 40, targetLeft));
        targetTop  = Math.max(-imgH + 40, Math.min(containerRect.height - 40, targetTop));

        el.style.left = targetLeft + 'px';
        el.style.top  = targetTop  + 'px';
      }
    });

    const stopDragResize = (e) => {
      if (activeDragImage === el) {
        activeDragImage = null;
        el.releasePointerCapture(e.pointerId);
      }
      if (activeResizeImage === el) {
        activeResizeImage = null;
        el.releasePointerCapture(e.pointerId);
      }
    };

    el.addEventListener('pointerup',     stopDragResize);
    el.addEventListener('pointercancel', stopDragResize);

    // ----- TouchEvents: ピンチイン・アウト -----
    el.addEventListener('touchstart', (e) => {
      if (currentMode !== 'photo') return;

      if (e.touches.length === 2) {
        e.stopPropagation();
        isPinching = true;
        selectImage(el);

        const t1 = e.touches[0];
        const t2 = e.touches[1];
        initialPinchDistance = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);

        const rect          = el.getBoundingClientRect();
        const containerRect = canvasContainer.getBoundingClientRect();

        initialPinchWidth  = rect.width;
        initialPinchHeight = rect.height;
        initialPinchX      = rect.left - containerRect.left;
        initialPinchY      = rect.top  - containerRect.top;

        // アスペクト比をここで確定（グローバル変数を汚染しない）
        pinchAspectRatio = initialPinchWidth / initialPinchHeight;
      }
    }, { passive: false });

    el.addEventListener('touchmove', (e) => {
      if (currentMode !== 'photo' || !isPinching || e.touches.length !== 2) return;

      e.stopPropagation();
      e.preventDefault(); // iPad Safari のスクロール・ズーム防止

      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const currentDistance = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);

      if (initialPinchDistance <= 0) return;

      const scale = currentDistance / initialPinchDistance;
      const containerRect = canvasContainer.getBoundingClientRect();

      let newWidth = Math.max(50, Math.min(containerRect.width * 1.5, initialPinchWidth * scale));
      let newHeight = newWidth / pinchAspectRatio; // ← 修正ポイント：画像ごとのアスペクト比を使用

      // 中心を固定したまま拡大縮小
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
  // 全消去（リセット）
  // =========================================================================
  clearBtn.addEventListener('click', () => {
    confirmModal.classList.remove('hidden');
  });

  modalCancelBtn.addEventListener('click', () => {
    confirmModal.classList.add('hidden');
  });

  modalConfirmBtn.addEventListener('click', () => {
    // キャンバスクリア前に undo 用として保存
    saveStateForUndo();

    const rect = canvasContainer.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    photoLayer.innerHTML = '';
    deselectAllImages();
    confirmModal.classList.add('hidden');
  });

  // =========================================================================
  // 保存（できた！）
  // =========================================================================
  saveBtn.addEventListener('click', () => {
    deselectAllImages();
    setTimeout(exportCardAsPNG, 150);
  });

  async function exportCardAsPNG() {
    const containerRect = canvasContainer.getBoundingClientRect();
    const exportDpr = window.devicePixelRatio || 1;

    // 保存用キャンバスを生成
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width  = containerRect.width  * exportDpr;
    exportCanvas.height = containerRect.height * exportDpr;
    const exportCtx = exportCanvas.getContext('2d');
    exportCtx.scale(exportDpr, exportDpr);

    // 1. 白背景
    exportCtx.fillStyle = '#ffffff';
    exportCtx.fillRect(0, 0, containerRect.width, containerRect.height);

    // 2. 写真レイヤーをDOM順（z-order通り）に描画
    const imgElements = Array.from(photoLayer.querySelectorAll('.draggable-image'));

    const drawTasks = imgElements.map(wrapper => new Promise((resolve) => {
      const img    = wrapper.querySelector('img');
      const left   = parseFloat(wrapper.style.left);
      const top    = parseFloat(wrapper.style.top);
      const width  = parseFloat(wrapper.style.width);
      const height = parseFloat(wrapper.style.height);

      // DataURL は同一オリジンなので toDataURL でも安全
      const exportImg = new Image();
      exportImg.onload  = () => resolve({ img: exportImg, left, top, width, height });
      exportImg.onerror = () => resolve(null);
      exportImg.src = img.src;
    }));

    const results = await Promise.all(drawTasks);
    results.forEach(item => {
      if (item) {
        exportCtx.drawImage(item.img, item.left, item.top, item.width, item.height);
      }
    });

    // 3. 手書きキャンバスを合成
    exportCtx.drawImage(canvas, 0, 0, containerRect.width, containerRect.height);

    // 4. ダウンロード / 共有
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

      // Web Share API 対応（iPad/iOS で写真アプリに直接保存できる）
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
          // ユーザーがキャンセルした場合は何もしない。それ以外はダウンロードにフォールバック
          if (shareErr.name === 'AbortError') return;
        }
      }

      // フォールバック：従来のダウンロードリンク
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
    // 少し待ってからフェードイン
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        saveToast.classList.add('show');
      });
    });
    // 2.5秒後にフェードアウト
    setTimeout(() => {
      saveToast.classList.remove('show');
      setTimeout(() => saveToast.classList.add('hidden'), 350);
    }, 2500);
  }

});

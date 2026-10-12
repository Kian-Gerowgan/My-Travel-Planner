// Renders every page of a PDF into canvases, so PDFs display fully on iPhone as well
// (Safari's built-in PDF frame only shows the first page). pdf.js is loaded on demand.

export async function renderPdf(blob: Blob, container: HTMLElement, width: number, isCancelled: () => boolean) {
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const workerUrl = (await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const doc = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  for (let n = 1; n <= doc.numPages; n++) {
    if (isCancelled()) break;
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: (width / base.width) * dpr });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
    canvas.className = 'block mx-auto bg-white rounded-md shadow-lift';
    container.appendChild(canvas);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  }
  return doc.numPages as number;
}

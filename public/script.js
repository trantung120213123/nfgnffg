// public/script.js (simplified, removed search, with localStorage draft)
document.getElementById('btnSave').onclick = savePaste;

// Load draft from localStorage
window.addEventListener('load', () => {
  const draftTitle = localStorage.getItem('draftTitle');
  const draftContent = localStorage.getItem('draftContent');
  if (draftTitle) document.getElementById('title').value = draftTitle;
  if (draftContent) document.getElementById('content').value = draftContent;
});

// Auto-save draft
document.getElementById('title').addEventListener('input', () => localStorage.setItem('draftTitle', document.getElementById('title').value));
document.getElementById('content').addEventListener('input', () => localStorage.setItem('draftContent', document.getElementById('content').value));

async function savePaste() {
  const title = document.getElementById('title').value.trim();
  const content = document.getElementById('content').value;
  const saveResult = document.getElementById('saveResult');
  saveResult.innerHTML = '<p class="text-blue-600">Đang lưu...</p>';

  if (!content || !content.trim()) {
    saveResult.innerHTML = '<p class="text-red-600">Nội dung không được trống!</p>';
    return;
  }

  try {
    const res = await fetch('/api/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, content })
    });

    if (!res.ok) {
      const jr = await res.json();
      throw new Error(jr.error || `HTTP ${res.status}`);
    }

    const j = await res.json();
    if (!j.id || !j.url || !j.raw) {
      throw new Error('Invalid response from server');
    }

    // Set cookie client-side as well
    if (j.token) document.cookie = `owner_token=${j.token};path=/;max-age=${10*365*24*3600}`;
    
    // Display links
    saveResult.innerHTML = `
      <p class="text-green-600 font-medium">Paste đã lưu!</p>
      <p><b>Paste:</b> <a href="${escapeHtml(j.url)}" target="_blank" class="text-indigo-600 hover:underline">${escapeHtml(j.url)}</a></p>
      <p><b>Raw:</b> <a href="${escapeHtml(j.raw)}" target="_blank" class="text-indigo-600 hover:underline">${escapeHtml(j.raw)}</a></p>
      <p class="text-sm text-gray-500">Token: ${escapeHtml(j.token.slice(0,8))}... (saved in cookie)</p>
    `;
    
    // Clear inputs and localStorage
    document.getElementById('content').value = '';
    document.getElementById('title').value = '';
    localStorage.removeItem('draftTitle');
    localStorage.removeItem('draftContent');

    // Clear result after 10 seconds
    setTimeout(() => { saveResult.innerHTML = ''; }, 10000);

    console.log('Saved:', j);
  } catch (e) {
    console.error('Save failed:', e);
    saveResult.innerHTML = `<p class="text-red-600">Lưu thất bại: ${escapeHtml(e.message || e)}</p>`;
  }
}

function escapeHtml(s) { 
  if (!s) return ''; 
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); 
}

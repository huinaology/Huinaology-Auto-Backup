// lib/template.js - DB의 "기본 템플릿(Auto_fill)"을 노션 API로 적용한다.
//  * @notionhq/client 2.x 의 pages.create / pages.update 는 template 파라미터를 버리므로 notion.request 로 직접 호출한다.
//  * notionVersion 2022-06-28 + database_id 부모에서 그대로 동작한다.
//  * 템플릿은 노션이 비동기로 적용한다(1~15초). 이름·날짜·아이콘·커버·기존 속성값은 덮어쓰이지 않으므로 기다리지 않는다.
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const DEFAULT_TEMPLATE = { type: 'default' };

// 429(요청 과다)이면 노션이 알려준 Retry-After 만큼 기다렸다 다시 시도한다.
async function request(notion, opts, tries = 4) {
    for (let i = 0; ; i++) {
        try { return await notion.request(opts); }
        catch (e) {
            if (e.status !== 429 || i >= tries - 1) throw e;
            const ra = Number(e.headers && typeof e.headers.get === 'function' ? e.headers.get('retry-after') : NaN);
            await sleep(Math.min(8000, (Number.isFinite(ra) && ra > 0 ? ra : 2) * 1000));
        }
    }
}

// 새 페이지 생성 + 기본 템플릿. 템플릿 때문에 거부되면(기본 템플릿 없음 등) 템플릿 없이 다시 만든다.
// pageData: { parent, properties, icon?, cover? } (children은 템플릿과 함께 보낼 수 없다)
async function createPage(notion, pageData) {
    try {
        const page = await request(notion, { path: 'pages', method: 'post', body: { ...pageData, template: DEFAULT_TEMPLATE } });
        return { page, templated: true };
    } catch (e) {
        if (e.status !== 400) throw e;
        const page = await request(notion, { path: 'pages', method: 'post', body: pageData });
        return { page, templated: false, fallbackReason: String(e.message || e).replace(/\s+/g, ' ').slice(0, 160) };
    }
}

// 이미 있는 페이지에 기본 템플릿 적용. erase=true 면 기존 본문을 지우고 교체, 아니면 본문 뒤에 덧붙는다.
function applyDefaultTemplate(notion, pageId, { erase = false } = {}) {
    const body = { template: DEFAULT_TEMPLATE };
    if (erase) body.erase_content = true;
    return request(notion, { path: `pages/${pageId}`, method: 'patch', body });
}

// 본문이 비어 있는지: 블록이 없거나, 내용 없는 빈 문단만 있는 경우
async function isBodyEmpty(notion, pageId) {
    const r = await request(notion, { path: `blocks/${pageId}/children`, method: 'get', query: { page_size: 10 } });
    if (r.has_more) return false;
    return (r.results || []).every(b => b.type === 'paragraph' && !(b.paragraph?.rich_text || []).length && !b.has_children);
}

module.exports = { request, createPage, applyDefaultTemplate, isBodyEmpty };

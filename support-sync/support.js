'use strict';

const byId = id => document.getElementById(id);
const loginForm = byId('login');
const searchForm = byId('search');
const announcer = byId('announcer');
const dateFormatter = new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Cairo' });
const stateDetails = {
    confirmed: ['أكد المكتب الترحيل', 'good', 'طابق رقم الفاتورة مع سجل المبيعات في المكتب لو العملية محل مراجعة.'],
    waiting: ['بانتظار المكتب', 'wait', 'الفاتورة وصلت للسحابة. راجع اتصال المكتب وآخر قراءة لطابور المزامنة.'],
    assignment: ['تعارض تخصيص العميل', 'bad', 'راجع الحساب الأصلي والمندوب المخصص له وأي فاتورة أدخلتها الإدارة قبل المحاولة مجددًا.'],
    customer: ['تعذّر ربط حساب العميل', 'bad', 'راجع اعتماد الحساب الأصلي وظهوره على نسخة المكتب.'],
    rejected: ['الترحيل يحتاج مراجعة', 'bad', 'راجع تفاصيل العملية في صحة المزامنة على المكتب.'],
    unknown: ['حالة غير مؤكدة', 'neutral', 'سجل السحابة غير كافٍ لتأكيد الترحيل.'],
};
const supportOutcomes = {
    OFFLINE: 'الهاتف سجّل انقطاع الاتصال', CONNECTION: 'تعذّر الاتصال بالسحابة',
    TIMEOUT: 'انتهت مهلة الاتصال', SESSION: 'جلسة الدخول أو صلاحية المزامنة تحتاج مراجعة',
    INCOMPLETE_REPLY: 'رد السحابة ناقص', NEEDS_REVIEW: 'عمليات تحتاج مراجعة',
    OTHER_ERROR: 'تعطّل غير مصنّف', COMPLETED: 'اكتملت هذه المرحلة',
};
let session = null;

function localDate(value) {
    if (!value) return '—';
    const time = Date.parse(value);
    return Number.isFinite(time) ? dateFormatter.format(time) : '—';
}

function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
}

function setAlert(id, message = '') {
    const alert = byId(id);
    alert.textContent = message;
    alert.hidden = !message;
}

function setBusy(form, button, busy, label) {
    button.disabled = busy;
    button.textContent = label;
    form.setAttribute('aria-busy', String(busy));
}

function fieldsList(values) {
    const fields = element('dl');
    for (const [name, value] of values) {
        const field = element('div');
        field.append(element('dt', name), element('dd', String(value ?? '—')));
        fields.append(field);
    }
    return fields;
}

function paymentFields(row) {
    return [['الإجمالي', row.total_amount], ['المدفوع', row.paid_amount], ['المتبقي', row.remaining_amount]];
}

function renderItems(items, label, missing) {
    if (!items) return element('p', missing, 'muted');
    const details = element('details', '', 'items');
    details.open = true;
    details.append(element('summary', `${label} (${items.length})`));
    const list = element('ul');
    const units = { PIECE: 'قطعة', CARTON: 'كرتونة', BOX: 'علبة', KG: 'كجم' };
    for (const item of items) {
        const row = element('li');
        const title = element('strong', item.name || item.productId || 'صنف غير محدد');
        title.dir = 'auto';
        row.append(title, fieldsList([
            ['الكمية المسجلة', item.quantity], ['الوحدة', units[String(item.unit).toUpperCase()] ?? item.unit],
            ['كمية الأساس', item.baseQuantity], ['سعر الوحدة', item.unitPrice],
        ]));
        list.append(row);
    }
    details.append(list);
    return details;
}

function makeResult(row) {
    const [label, tone, guidance] = stateDetails[row.state];
    const article = element('article', '', 'result-row');
    const heading = element('div', '', 'row-heading');
    const title = element('h3', row.invoice || 'فاتورة بدون رقم موبايل في الإيصال');
    title.dir = 'auto';
    const cancelled = /cancel/i.test(row.eventType ?? '');
    heading.append(title, element('span', cancelled ? `طلب إلغاء · ${label}` : label, `tag ${tone}`));
    const fields = fieldsList([
        ['وقت الوصول للسحابة', localDate(row.received)],
        ['وقت الترحيل المؤكد', localDate(row.processed)],
        ['رقم الفاتورة في المكتب', row.desktopNumber ?? '—'],
        ['المحاولات الفاشلة', row.retries ?? '—'],
    ]);
    article.append(heading, fields, element('p', guidance, 'muted'));
    if (row.total_amount != null) article.append(fieldsList(paymentFields(row)));
    if (row.items) article.append(renderItems(row.items, 'أصناف الموبايل', ''));
    return article;
}

function makeOfficeResult(report) {
    const article = element('article', '', 'result-row');
    article.append(element('h3', `فاتورة المكتب ${report.officeNumber}`));
    const saved = report.officeInvoice;
    if (!saved) {
        article.append(element('p', report.officeUnavailable ? 'قراءة فواتير المكتب غير متاحة لهذا المشروع حاليًا.' : 'لم يتم العثور على فاتورة مكتب بهذا الرقم للمندوب.', 'muted'));
        return article;
    }
    article.append(fieldsList([['تاريخ الفاتورة', localDate(saved.invoice_date)], ...paymentFields(saved)]));
    article.append(renderItems(saved.items, 'أصناف المكتب', 'إجماليات الفاتورة متاحة. تفاصيل الأصناف لم تصل للسحابة بعد.'));
    return article;
}

function makeSupportLog(log) {
    const article = element('article', '', 'result');
    article.append(element('h3', 'سجل المزامنة على الهاتف'));
    if (!log?.length) {
        article.append(element('p', log === null ? 'سجل الهاتف غير متاح في هذا المشروع حاليًا.' :
            'لم يصل سجل من هذا الهاتف بعد. آخر اتصال لا يثبت ظهور البيانات أو تأكيد المكتب.', 'muted'));
        return article;
    }
    const list = element('ul');
    for (const entry of log) {
        const phase = entry.phase === 'PUSH' ? 'الرفع' : 'التنزيل';
        const outcome = supportOutcomes[entry.outcome] || 'حالة غير معروفة';
        list.append(element('li', `${phase} · ${outcome} · وقت الهاتف ${localDate(entry.observed_at)} · وصول السجل ${localDate(entry.received_at)}`));
    }
    article.append(list);
    return article;
}

function showReport(report) {
    const name = report.rep.name || report.rep.code;
    byId('result-meta').textContent = `${name} · توقيت القاهرة`;
    const messages = [];
    if (report.more) messages.push('تعرض الصفحة أحدث ٥٠ نتيجة. ابحث برقم الفاتورة للوصول لعملية أقدم.');
    if (report.projectionUnavailable) messages.push('رقم الفاتورة في سجل المكتب غير متاح من السحابة حاليًا.');
    const note = byId('sample-note');
    note.textContent = messages.join(' ');
    note.hidden = !messages.length;
    const rows = [makeSupportLog(report.supportLog), ...report.rows.map(makeResult)];
    if (report.mobileRequested && !report.rows.length) rows.push(element('p', 'السحابة لا تعرض إيصال موبايل مطابقًا.'));
    if (report.officeNumber) rows.push(makeOfficeResult(report));
    byId('result-list').replaceChildren(...rows);
    byId('results').hidden = false;
    announcer.textContent = 'اكتمل البحث في الفواتير.';
}

function endSession(message = '') {
    session = null;
    byId('connected-project').textContent = '';
    byId('result-list').replaceChildren();
    byId('result-meta').textContent = '';
    announcer.textContent = '';
    setAlert('search-error');
    byId('results').hidden = true;
    byId('workspace').hidden = true;
    byId('logout').hidden = true;
    loginForm.reset();
    searchForm.reset();
    byId('connect').hidden = false;
    setAlert('login-error', message);
    byId('project').focus();
}

loginForm.addEventListener('submit', async event => {
    event.preventDefault();
    const button = byId('login-button');
    if (button.disabled) return;
    setAlert('login-error');
    setBusy(loginForm, button, true, 'جاري الاتصال…');
    const input = Object.fromEntries(new FormData(loginForm));
    byId('password').value = '';
    try {
        session = await CloudSyncSupport.signIn(input);
        loginForm.reset();
        byId('connect').hidden = true;
        byId('workspace').hidden = false;
        byId('logout').hidden = false;
        byId('connected-project').textContent = session.project;
        byId('rep-code').focus();
    } catch (error) {
        setAlert('login-error', error.code ? error.message : 'تعذّر فتح جلسة دعم.');
    } finally {
        setBusy(loginForm, button, false, 'اتصال بمشروع الشركة');
    }
});

searchForm.addEventListener('submit', async event => {
    event.preventDefault();
    const button = byId('search-button');
    if (!session || button.disabled) return;
    const activeSession = session;
    const { repCode, invoiceCode, officeNumber, filter } = Object.fromEntries(new FormData(searchForm));
    setAlert('search-error');
    announcer.textContent = '';
    byId('results').hidden = true;
    setBusy(searchForm, button, true, 'جاري القراءة…');
    try {
        const report = await CloudSyncSupport.diagnose(activeSession, { repCode, invoiceCode, officeNumber, blockedOnly: filter === 'blocked' });
        if (activeSession === session) showReport(report);
    } catch (error) {
        if (activeSession !== session) return;
        if (error.code === 'expired') endSession(error.message);
        else setAlert('search-error', error.code ? error.message : 'تعذّر عرض حالة المزامنة.');
    } finally {
        setBusy(searchForm, button, false, 'عرض الحالة');
    }
});

byId('logout').addEventListener('click', () => endSession());
window.addEventListener('pagehide', () => { if (session) endSession(); });

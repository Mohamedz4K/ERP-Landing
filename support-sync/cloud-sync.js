'use strict';

const CloudSyncSupport = (() => {
    const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
    const OPERATOR_ROLES = new Set(['owner', 'admin', 'manager']);
    const PAGE_SIZE = 50;
    const BAD_STATES = '(FAILED,DEAD)';
    const events = 'aggregate_id,event_type,status,received_at,processed_at,retry_count,error_message,invoice_code:payload->>invoice_code';
    const messages = {
        configuration: 'اكتب رابط مشروع Supabase والمفتاح العام للمشروع.',
        permission: 'يلزم حساب إدارة سحابي مرتبط بالشركة والمؤسسة.',
        login: 'تعذّر تسجيل الدخول. راجع المشروع والبريد وكلمة المرور.',
        mfa: 'الحساب يتطلب تحققًا إضافيًا. هذه الشاشة لا تدعم إكمال التحقق متعدد العوامل.',
        expired: 'انتهت الجلسة. سجّل الدخول من جديد.',
        request: 'تعذّر قراءة سجلات المزامنة. تحقق من الاتصال وصلاحيات الحساب.',
        rep: 'كود المندوب غير صحيح أو غير متاح في هذه الشركة.',
        invoice: 'اكتب رقم فاتورة الموبايل بصيغة مثل M-INV-000012.',
        office: 'اكتب رقم فاتورة المكتب كما يظهر في سجل المبيعات.',
        response: 'استجابة السحابة غير مكتملة. أعد القراءة.',
    };

    function failure(code) {
        return Object.assign(new Error(messages[code]), { code });
    }

    function readJwt(token) {
        try {
            const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
            return JSON.parse(atob(part));
        } catch {
            return {};
        }
    }

    function projectOrigin(value) {
        const normalized = value.trim().toLowerCase();
        const match = /^(?:https:\/\/)?([a-z0-9]{20})(?:\.supabase\.co\/?)?$/.exec(normalized);
        if (!match) throw failure('configuration');
        return `https://${match[1]}.supabase.co`;
    }

    function publicKey(value, origin) {
        const key = value.trim();
        if (/^sb_publishable_[\w-]+$/.test(key)) return key;
        if (/^[\w-]+\.[\w-]+\.[\w-]+$/.test(key)) {
            const claims = readJwt(key);
            if (claims.role === 'anon' && origin === `https://${claims.ref}.supabase.co`) return key;
        }
        throw failure('configuration');
    }

    async function send(origin, key, endpoint, { token, body, params, fetcher }) {
        const url = new URL(endpoint, origin);
        url.search = new URLSearchParams(params);
        let response;
        try {
            response = await fetcher(url, {
                method: body ? 'POST' : 'GET',
                cache: 'no-store',
                credentials: 'omit',
                redirect: 'error',
                referrerPolicy: 'no-referrer',
                headers: {
                    apikey: key,
                    ...(token && { Authorization: `Bearer ${token}` }),
                    ...(body && { 'Content-Type': 'application/json' }),
                },
                ...(body && { body: JSON.stringify(body) }),
                signal: AbortSignal.timeout(12000),
            });
        } catch {
            throw failure('request');
        }
        if (!response.ok) {
            if (body && [400, 401, 403].includes(response.status)) throw failure('login');
            if (response.status === 401) throw failure('expired');
            throw failure('request');
        }
        return response.json().catch(() => { throw failure('response'); });
    }

    async function signIn({ project, key: enteredKey, email, password }, fetcher = fetch) {
        const origin = projectOrigin(project);
        const key = publicKey(enteredKey, origin);
        const access = await send(origin, key, '/auth/v1/token', {
            body: { email, password }, params: { grant_type: 'password' }, fetcher,
        });
        const token = access.access_token;
        if (typeof token !== 'string') throw failure('login');
        const profile = await send(origin, key, '/auth/v1/user', { token, fetcher });
        const { role, tenant_id, organization_id } = profile.app_metadata ?? {};
        const claims = readJwt(token);
        if (!OPERATOR_ROLES.has(role) || !UUID.test(tenant_id) || !UUID.test(organization_id)
            || claims.sub !== profile.id || claims.app_metadata?.role !== role
            || claims.app_metadata?.tenant_id !== tenant_id || claims.app_metadata?.organization_id !== organization_id) {
            throw failure('permission');
        }
        if (claims.aal !== 'aal2' && profile.factors?.some(factor => factor.status === 'verified')) {
            throw failure('mfa');
        }
        const scope = { tenant_id: `eq.${tenant_id}`, organization_id: `eq.${organization_id}` };
        async function read(table, params) {
            const rows = await send(origin, key, `/rest/v1/${table}`, { token, params: { ...params, ...scope }, fetcher });
            if (!Array.isArray(rows)) throw failure('response');
            return rows;
        }
        async function readOfficeInvoice(repId, invoiceNumber) {
            const rows = await send(origin, key, '/rest/v1/rpc/erp_support_read_rep_invoice', {
                token, fetcher, params: { p_rep_id: repId, p_invoice_number: invoiceNumber },
            });
            if (!Array.isArray(rows) || rows.length > 1) throw failure('response');
            return rows[0] ?? null;
        }
        return { project: new URL(origin).hostname, read, readOfficeInvoice };
    }

    function classify(event) {
        const { status, error_message: error = '' } = event;
        const diagnostic = String(error ?? '');
        if (status === 'PROCESSED' && event.processed_at) return 'confirmed';
        if (status === 'PENDING' || status === 'PROCESSING') return 'waiting';
        if (status !== 'FAILED' && status !== 'DEAD') return 'unknown';
        if (/العميل غير مخصص|CUSTOMER_REP_SCOPE_DENIED/i.test(diagnostic)) return 'assignment';
        if (/تعذر ربط عميل|SFA_CUSTOMER_SYNC_REQUIRED/i.test(diagnostic)) return 'customer';
        return 'rejected';
    }

    function invoiceItems(items, productNames = new Map()) {
        if (!Array.isArray(items) || !items.length || items.length > 1000) return null;
        return items.map(line => {
            const productId = line?.product_id ?? line?.productId ?? null;
            return {
                productId,
                name: line?.name ?? productNames.get(productId) ?? null,
                quantity: line?.entered_quantity ?? line?.enteredQuantity ?? line?.quantity ?? null,
                baseQuantity: line?.base_quantity ?? line?.baseQuantity ?? null,
                unit: line?.selected_unit ?? line?.selectedUnit ?? null,
                unitPrice: line?.unit_price ?? line?.unitPrice ?? null,
            };
        });
    }

    async function diagnose(session, { repCode, invoiceCode, officeNumber = '', blockedOnly }) {
        const rep = repCode.trim().toUpperCase();
        const invoice = invoiceCode.trim().toUpperCase();
        const office = officeNumber.trim();
        if (!/^[A-Z0-9_-]{2,32}$/.test(rep)) throw failure('rep');
        if (invoice && !/^M-INV-[0-9]{1,18}$/.test(invoice)) throw failure('invoice');
        if (office && !/^[A-Za-z0-9_/-]{1,32}$/.test(office)) throw failure('office');
        const records = await session.read('sales_representatives', { select: 'id,code,name', code: `eq.${rep}`, limit: 2 });
        if (records.length !== 1 || !UUID.test(records[0].id)) throw failure('rep');
        const repId = records[0].id;
        const supportLog = session.read('mobile_sync_support_log', {
            select: 'phase,outcome,observed_at,received_at', rep_id: `eq.${repId}`, order: 'received_at.desc', limit: 20,
        }).catch(() => null);
        const queries = {
            select: invoice ? `${events},items:payload->items,total_amount:payload->total_amount,paid_amount:payload->paid_amount,remaining_amount:payload->remaining_amount` : events,
            rep_id: `eq.${repId}`,
            aggregate_type: 'eq.SalesInvoice',
            order: 'received_at.desc,id.desc',
            limit: PAGE_SIZE + 1,
        };
        if (invoice) queries['payload->>invoice_code'] = `eq.${invoice}`;
        else if (blockedOnly) queries.status = `in.${BAD_STATES}`;
        const found = office && !invoice ? [] : await session.read('cloud_sync_inbox', queries);
        const visible = found.slice(0, PAGE_SIZE);
        const confirmedIds = [...new Set(visible.filter(event => classify(event) === 'confirmed' && !/cancel/i.test(event.event_type ?? ''))
            .map(event => event.aggregate_id).filter(id => UUID.test(id)))];
        let erpNumbers = new Map();
        let projectionUnavailable = false;
        if (confirmedIds.length) {
            try {
                const synced = await session.read('invoices', {
                    select: 'id,invoice_number', sales_rep_id: `eq.${repId}`, id: `in.(${confirmedIds.join(',')})`,
                    limit: confirmedIds.length,
                });
                erpNumbers = new Map(synced.map(row => [row.id, row.invoice_number]));
            } catch (error) {
                if (error.code === 'expired') throw error;
                projectionUnavailable = true;
            }
        }
        const scopedProducts = new Map();
        if (invoice) {
            const productIds = [...new Set(visible.flatMap(event => (invoiceItems(event.items) ?? [])
                .map(item => item.productId).filter(id => UUID.test(id))))].slice(0, 500);
            try {
                for (let offset = 0; offset < productIds.length; offset += 50) {
                    const batch = productIds.slice(offset, offset + 50);
                    const products = await session.read('products', { select: 'id,name', id: `in.(${batch.join(',')})`, limit: batch.length });
                    for (const product of products) scopedProducts.set(product.id, product.name);
                }
            } catch (error) {
                if (error.code === 'expired') throw error;
            }
        }
        let officeInvoice = null;
        let officeUnavailable = false;
        if (office) {
            try {
                const saved = await session.readOfficeInvoice(repId, office);
                if (saved) officeInvoice = { ...saved, items: invoiceItems(saved.items) };
            } catch (error) {
                if (error.code === 'expired') throw error;
                officeUnavailable = true;
            }
        }
        return {
            rep: records[0], more: found.length > PAGE_SIZE, projectionUnavailable, supportLog: await supportLog,
            officeNumber: office, officeInvoice, officeUnavailable, mobileRequested: !!invoice || !office,
            rows: visible.map(event => ({
                invoice: event.invoice_code, desktopNumber: erpNumbers.get(event.aggregate_id),
                state: classify(event), received: event.received_at, eventType: event.event_type,
                processed: event.processed_at, retries: event.retry_count,
                items: invoiceItems(event.items, scopedProducts),
                total_amount: event.total_amount, paid_amount: event.paid_amount, remaining_amount: event.remaining_amount,
            })),
        };
    }

    return { signIn, diagnose, classify };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CloudSyncSupport;

import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../../app/AppContext';
import { Icon } from '../../components/common/Icon';
import { Alert, Count } from '../../components/common/ui';
import { ATTENTION_DAYS } from '../../config/policy';
import { adminKpis, employeeKpis, waitingLong } from '../../domain/lists';
import { ApiError } from '../../services/apiClient';
import type { RecordKind, TravelClaimRecord } from '../../types/domain';
import { longDate, money, plural, today } from '../../utils/format';
import { RecordList, type ListPreset } from '../shared/RecordList';

interface Card { key: string; tone: string; icon: string; label: string; value: string; sub: string; kind?: RecordKind; filter: { label: string; test: (r: TravelClaimRecord) => boolean } | null }

// Each role remembers the request-type tab it last used (as in the prototype).
const lastKind: Record<string, RecordKind> = {};
/** Forms return to the dashboard opened on their own request type (prototype behaviour). */
export const rememberDashboardKind = (role: string, kind: RecordKind): void => { lastKind[role] = kind; };

export function DashboardPage() {
  const { gateway, session, isAdmin } = useApp();
  const [all, setAll] = useState<TravelClaimRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unused, setUnused] = useState(0);
  const [activeCard, setActiveCard] = useState<string | null>(null);
  const [preset, setPreset] = useState<ListPreset | null>(null);
  const [kind, setKind] = useState<RecordKind>(lastKind[session.role] ?? 'claim');
  const [token, setToken] = useState(0);

  useEffect(() => {
    let off = false;
    gateway.listRecords({}).then((p) => { if (!off) setAll(p.rows); }).catch((e: unknown) => { if (!off) setError(e instanceof ApiError ? e.message : 'Could not load your dashboard.'); });
    if (!isAdmin) gateway.listReceipts().then((r) => { if (!off) setUnused(r.filter((x) => !x.usedIn).length); }).catch(() => undefined);
    return () => { off = true; };
  }, [gateway, isAdmin, session.code]);

  const now = useMemo(() => new Date(), []);
  const cards: Card[] = useMemo(() => {
    if (!all) return [];
    if (!isAdmin) {
      const k = employeeKpis(all);
      return [
        { key: 'total', tone: 'brand', icon: 'receipt', label: 'Total claims', value: String(k.totalClaims), sub: 'Across all statuses', kind: 'claim', filter: null },
        { key: 'claimed', tone: 'orange', icon: 'banknote', label: 'Claimed amount', value: money(k.claimedAmount), sub: 'Total submitted value', kind: 'claim', filter: { label: 'Submitted, approved or rejected', test: (r) => r.status !== 'draft' } },
        { key: 'approved', tone: 'success', icon: 'check-circle', label: 'Approved amount', value: money(k.approvedAmount), sub: 'Approved across ' + plural(k.approvedCount, 'claim'), kind: 'claim', filter: { label: 'Approved', test: (r) => r.status === 'approved' } },
        { key: 'attention', tone: 'warning', icon: 'hourglass', label: 'Needs attention', value: String(k.attention), sub: k.attention ? plural(k.drafts, 'draft') + ' · ' + plural(k.rejected, 'rejected', 'rejected') : 'Nothing to act on', kind: 'claim', filter: { label: 'Drafts and rejected', test: (r) => r.status === 'draft' || r.status === 'rejected' } },
      ];
    }
    const k = adminKpis(all, now);
    const pending = { label: 'Pending approval', test: (r: TravelClaimRecord) => r.status === 'submitted' };
    return [
      { key: 'pending', tone: 'brand', icon: 'inbox', label: 'Pending approvals', value: String(k.pendingCount), sub: `${k.pendingByKind.claim} claims · ${k.pendingByKind.travel} travel · ${k.pendingByKind.advance} advance`, filter: pending },
      { key: 'pendingAmount', tone: 'orange', icon: 'banknote', label: 'Pending amount', value: money(k.pendingAmount), sub: 'Total requested value', filter: pending },
      { key: 'approved', tone: 'success', icon: 'check-circle', label: 'Approved amount', value: money(k.approvedAmount), sub: 'Approved across ' + plural(k.approvedCount, 'request'), filter: { label: 'Approved', test: (r) => r.status === 'approved' } },
      { key: 'attention', tone: 'warning', icon: 'hourglass', label: 'Needs attention', value: String(k.overdueCount), sub: k.overdueCount ? `Waiting over ${ATTENTION_DAYS} days · oldest ${plural(k.oldestDays, 'day')}` : `Nothing waiting over ${ATTENTION_DAYS} days`, filter: { label: `Pending over ${ATTENTION_DAYS} days`, test: (r) => waitingLong(r, now) } },
    ];
  }, [all, isAdmin, now]);

  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const first = session.name.split(' ')[0] ?? session.name;

  const pick = (c: Card): void => {
    const off = activeCard === c.key || !c.filter;
    setActiveCard(off ? null : c.key);
    setPreset(off || !c.filter ? null : { label: c.filter.label, test: c.filter.test, kind: c.kind ?? null });
    if (c.kind) { setKind(c.kind); lastKind[session.role] = c.kind; }
    setToken((n) => n + 1);
    document.getElementById('tc-dash-list')?.scrollIntoView({ block: 'nearest' });
  };

  return (
    <>
      <div className="tc-page-header">
        <div><h1 className="tc-page-title">{greet}, {first}</h1><p className="tc-page-subtitle">{longDate(today())}</p></div>
        {!isAdmin ? (
          <div className="tc-page-actions">
            <a className="tc-btn tc-btn--secondary" href="#/receipts" aria-label={`Receipt box, ${plural(unused, 'unused bill')}`} data-testid="receipt-box-link">
              <Icon name="inbox" /><span>Receipt box</span>{unused ? <Count n={unused} /> : null}
            </a>
          </div>
        ) : null}
      </div>
      <div className="tc-stack">
        {error ? <Alert tone="error" title="Could not load your dashboard">{error}</Alert> : (
          <div className="tc-stats" role="group" aria-label="Summary filters">
            {(all ? cards : []).map((c) => (
              <button key={c.key} type="button" className={`tc-kpi tc-kpi--${c.tone}${activeCard === c.key ? ' is-active' : ''}`} aria-pressed={activeCard === c.key} aria-controls="tc-dash-list" data-testid={`kpi-${c.key}`} onClick={() => pick(c)}>
                <span className="tc-kpi__top"><Icon name={c.icon} className="tc-kpi__icon" size={18} /><span className="tc-kpi__label">{c.label}</span><span className="tc-kpi__live">Live</span></span>
                <span className="tc-kpi__value">{c.value}</span><span className="tc-kpi__sub">{c.sub}</span>
              </button>
            ))}
          </div>
        )}
        <div id="tc-dash-list">
          <RecordList embedded kind={kind} preset={preset} resetToken={token}
            onKindChange={(k) => { setKind(k); lastKind[session.role] = k; if (preset?.kind && preset.kind !== k) { setPreset(null); setActiveCard(null); } }}
            onPresetClear={() => { setPreset(null); setActiveCard(null); }} />
        </div>
      </div>
    </>
  );
}

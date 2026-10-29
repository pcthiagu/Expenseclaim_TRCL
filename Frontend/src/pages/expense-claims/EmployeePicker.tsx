import { useEffect, useState } from 'react';
import { Icon } from '../../components/common/Icon';
import { Field } from '../../components/forms/Field';
import { ModalFrame, useModal } from '../../components/modals/ModalHost';
import type { TravelClaimGateway } from '../../services/ports';
import type { Employee } from '../../types/domain';
import { initials } from '../../utils/format';

/** Approver-only employee lookup ("Help" beside Employee Code). Results come from the gateway, not a local list. */
export function EmployeePicker({ gateway, onPick }: { gateway: TravelClaimGateway; onPick: (e: Employee) => void }) {
  const { close } = useModal();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Employee[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let off = false;
    // A short pause while typing: one database lookup per pause, not one per keystroke (the first load, with an empty box, is immediate).
    const t = setTimeout(() => {
      gateway.lookupEmployees(q).then((r) => { if (!off) { setRows(r); setErr(null); } }).catch((e: unknown) => { if (!off) setErr(e instanceof Error ? e.message : 'Lookup failed'); });
    }, q ? 250 : 0);
    return () => { off = true; clearTimeout(t); };
  }, [q, gateway]);
  return (
    <ModalFrame title="Find employee" size="sm" testId="employee-picker">
      <Field type="search" value={q} onChange={(v) => setQ(String(v))} placeholder="Search by code, name or department" ariaLabel="Search employees" testId="picker-q" />
      {err ? <p className="tc-text-secondary tc-pick">{err}</p>
        : rows && !rows.length ? <p className="tc-text-secondary tc-pick">No employees match.</p>
        : <div className="tc-pick">
            {(rows ?? []).map((e) => (
              <button key={e.code} type="button" className="tc-pick__item" data-testid={`pick-emp-${e.code}`} onClick={() => { onPick(e); close(); }}>
                <span className="tc-avatar tc-avatar--sm" aria-hidden="true">{initials(e.name)}</span>
                <span className="tc-pick__text"><span className="tc-pick__name">{e.name}</span><br /><span className="tc-pick__meta">{e.code} · {e.department} · {e.costCentre}</span></span>
                <Icon name="chevron-right" />
              </button>
            ))}
          </div>}
    </ModalFrame>
  );
}

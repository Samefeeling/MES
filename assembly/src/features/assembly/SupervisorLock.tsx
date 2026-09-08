/**
 * The header lock. Shown only when `VITE_SUPERVISOR_PASSWORD` is configured —
 * with no password there is nothing to unlock, so the control would be noise.
 *
 * See `store/supervisorStore` for what this gate is and is not.
 */

import { useEffect, useRef, useState } from 'react';
import { useSupervisorStore } from '@/store/supervisorStore';
import { Button } from '@/ui';

export function SupervisorLock() {
  const required = useSupervisorStore((s) => s.required);
  const unlocked = useSupervisorStore((s) => s.unlocked);
  const error = useSupervisorStore((s) => s.error);
  const unlock = useSupervisorStore((s) => s.unlock);
  const lock = useSupervisorStore((s) => s.lock);
  const clearError = useSupervisorStore((s) => s.clearError);

  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (asking) input.current?.focus();
  }, [asking]);

  if (window.parent !== window) return null;
  if (!required) return null;

  const submit = () => {
    if (unlock(password)) {
      setPassword('');
      setAsking(false);
    }
  };

  if (unlocked) {
    return (
      <button
        type="button"
        className="supervisor-chip open"
        title="Allocation is unlocked. Click to lock it again."
        onClick={() => lock()}
      >
        🔓 Supervisor
      </button>
    );
  }

  return (
    <span className="supervisor-wrap">
      <button
        type="button"
        className="supervisor-chip"
        title="Allocating crew needs the supervisor password"
        onClick={() => {
          clearError();
          setAsking((a) => !a);
        }}
      >
        🔒 Supervisor
      </button>
      {asking && (
        <div className="supervisor-prompt" onClick={(e) => e.stopPropagation()}>
          <label htmlFor="supervisor-password">Supervisor password</label>
          <input
            id="supervisor-password"
            ref={input}
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (error) clearError();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
              if (e.key === 'Escape') {
                // Handled here, so the board's own Escape does not also close
                // whatever is open behind this.
                e.stopPropagation();
                setAsking(false);
              }
            }}
          />
          {error && <span className="supervisor-error">{error}</span>}
          <div className="supervisor-actions">
            <Button variant="primary" onClick={submit}>
              Unlock
            </Button>
            <Button onClick={() => setAsking(false)}>Cancel</Button>
          </div>
        </div>
      )}
    </span>
  );
}

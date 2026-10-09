// Small building blocks used across pages.
import { useEffect, useId, useRef } from 'react';
import { STATUS_LABELS, initials } from '../lib/format.js';

export function Button({ variant = 'primary', size, loading = false, disabled = false, className = '', children, ...props }) {
  const classes = ['btn', `btn-${variant}`, size === 'small' ? 'btn-small' : '', className].filter(Boolean).join(' ');
  return (
    <button type="button" {...props} className={classes} disabled={disabled || loading} aria-busy={loading || undefined}>
      {loading ? <span className="spinner" aria-hidden="true" /> : null}
      <span>{children}</span>
    </button>
  );
}

export function Field({ label, hint, error, as = 'input', className = '', ...props }) {
  const id = useId();
  const Control = as;
  const messageId = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className={`field ${className}`}>
      <label htmlFor={id}>{label}</label>
      <Control id={id} aria-invalid={error ? true : undefined} aria-describedby={messageId} {...props} />
      {error ? (
        <p id={messageId} className="field-error">
          {error}
        </p>
      ) : hint ? (
        <p id={messageId} className="field-hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Alert({ tone = 'info', children }) {
  if (!children) return null;
  return (
    <div className={`alert alert-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export function StatusBadge({ status }) {
  return <span className={`status status-${status}`}>{STATUS_LABELS[status] ?? status}</span>;
}

export function Avatar({ name, size = 'md' }) {
  return (
    <span className={`avatar avatar-${size}`} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

export function ScoreBar({ label, value }) {
  return (
    <div className="score">
      <span className="score-label">{label}</span>
      <span className="score-track" aria-hidden="true">
        <span className="score-fill" style={{ width: `${value * 10}%` }} />
      </span>
      <span className="score-value">
        {value}
        <span className="visually-hidden"> out of 10</span>
      </span>
    </div>
  );
}

export function PageLoader({ label = 'Loading', full = false }) {
  return (
    <div className={`loader ${full ? 'loader-full' : ''}`} role="status">
      <span className="spinner spinner-large" aria-hidden="true" />
      <span>{label}…</span>
    </div>
  );
}

export function EmptyState({ title, children, action }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children ? <p className="empty-body">{children}</p> : null}
      {action}
    </div>
  );
}

// A modal built on the native <dialog> element: focus trapping and Esc come for free.
export function ConfirmDialog({ open, title, children, confirmLabel, tone = 'primary', busy = false, confirmDisabled = false, onConfirm, onCancel }) {
  const ref = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <h2 id={titleId} className="dialog-title">
        {title}
      </h2>
      <div className="dialog-body">{children}</div>
      <div className="dialog-actions">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant={tone} onClick={onConfirm} loading={busy} disabled={confirmDisabled}>
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}

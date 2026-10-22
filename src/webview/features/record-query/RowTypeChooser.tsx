import type React from 'react';
import { useRef, useState } from 'react';
import { ListFilter } from 'lucide-react';
import { useLightDismiss } from '../../shared/hooks/use-light-dismiss';
import { useViewportPopover } from '../../use-viewport-popover';
import { MAX_ROW_TYPES, type RowTypeSelection, type RowTypeSource } from './query-selection';

export interface RowTypeChooserProps {
  sources: readonly RowTypeSource[];
  selection?: RowTypeSelection | undefined;
  disabled: boolean;
  onChange: (selection: RowTypeSelection | undefined) => void;
}

export function RowTypeChooser({ sources, selection, disabled, onChange }: RowTypeChooserProps): React.JSX.Element {
  const menuRef = useRef<HTMLDetailsElement>(null);
  useLightDismiss(menuRef);
  useViewportPopover(menuRef);
  const [sourceId, setSourceId] = useState(selection?.column.id ?? '');
  const [customValue, setCustomValue] = useState('');
  const preferred = sources.find((candidate) => candidate.column.source === 'profile') ?? sources[0];
  const source = sources.find((candidate) => candidate.column.id === (selection?.column.id ?? sourceId)) ?? preferred;
  const values = selection !== undefined && source?.column.id === selection.column.id ? selection.values : [];
  const active = values.length > 0;
  const setValues = (next: string[]): void => {
    if (source !== undefined) {
      setSourceId(source.column.id);
      onChange(next.length === 0 ? undefined : { column: source.column, values: next });
    }
  };
  return <details className="filter-menu row-types-menu" ref={menuRef}>
    <summary className={`query-tool-button${active ? ' is-active' : ''}`} title="Row types: include any selected type" aria-label="Row types"
      aria-description={active ? `${values.length} row types selected` : undefined}>
      <ListFilter size={15} aria-hidden /><span className="query-tool-label">Row types</span>
      {active ? <span className="query-tool-count" aria-hidden="true">({values.length})</span> : null}
    </summary>
    <div className="filter-popover row-type-popover" data-popover-width="300" data-popover-height="480">
      <strong>Row types</strong>
      <small>Match any selected type, and match the search and all field filters. No selection includes all types.</small>
      {source === undefined ? <small>No row-type field is available yet. Choose an Agent profile or wait for a top-level record type.</small> : <>
        {sources.length > 1 ? <label><span>Type</span><select aria-label="Row type source" value={source.column.id}
          disabled={disabled} onChange={(event) => { setSourceId(event.target.value); onChange(undefined); }}>
          {sources.map((candidate) => <option key={candidate.column.id} value={candidate.column.id}>{candidate.column.label}</option>)}
        </select></label> : null}
        <fieldset disabled={disabled}><legend>{source.column.label}</legend>
          {source.values.map((value) => <label className="row-type-option" key={value}>
            <input type="checkbox" checked={values.includes(value)}
              disabled={!values.includes(value) && values.length >= MAX_ROW_TYPES}
              onChange={(event) => setValues(event.target.checked ? [...values, value] : values.filter((current) => current !== value))} />
            <span>{source.column.source === 'profile' ? value.replaceAll('_', ' ') : value}</span>
          </label>)}
        </fieldset>
        {source.sampled ? <>
          <small>Values come from bounded schema samples. Add an exact record type if it has not appeared here.</small>
          <form className="row-type-add" onSubmit={(event) => {
            event.preventDefault();
            const value = customValue.trim();
            if (value && value.length <= 128 && !values.includes(value) && values.length < MAX_ROW_TYPES) {
              setValues([...values, value]); setCustomValue('');
            }
          }}>
            <input aria-label="Add exact record type" placeholder="Exact record type" maxLength={128} value={customValue}
              disabled={disabled} onChange={(event) => setCustomValue(event.target.value)} />
            <button type="submit" disabled={disabled || !customValue.trim() || values.length >= MAX_ROW_TYPES}>Add</button>
          </form>
        </> : null}
      </>}
      <button type="button" disabled={disabled || selection === undefined} onClick={() => onChange(undefined)}>Show all types</button>
    </div>
  </details>;
}

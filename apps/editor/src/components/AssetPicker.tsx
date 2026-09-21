import React, { useRef, useState } from 'react';
import { assetFileUrl, type Asset } from '../api/client';

interface Props {
  projectId: string;
  assets: Asset[];
  selected: string[];
  onChange: (ids: string[]) => void;
  // Uploads the files to the library and resolves with the new assets, which are then selected.
  onUpload: (files: File[]) => Promise<Asset[]>;
  disabled?: boolean;
}

export const AssetPicker: React.FC<Props> = ({ projectId, assets, selected, onChange, onUpload, disabled }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);

  const handleFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      const added = await onUpload(files);
      if (added.length > 0) onChange([...selected, ...added.map((a) => a.id)]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div
      className="asset-picker"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (!disabled) handleFiles(Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/')));
      }}
    >
      <div className="asset-picker-grid">
        {assets.map((a) => {
          const on = selected.includes(a.id);
          return (
            <button
              key={a.id}
              type="button"
              disabled={disabled}
              className={`asset-thumb${on ? ' asset-thumb-on' : ''}`}
              title={`${a.name}${a.description ? ` — ${a.description}` : ''}`}
              aria-pressed={on}
              onClick={() => toggle(a.id)}
            >
              <img src={assetFileUrl(projectId, a)} alt={a.name} />
              {on && <span className="asset-thumb-check">✓</span>}
            </button>
          );
        })}
        <button
          type="button"
          className="asset-thumb asset-thumb-add"
          disabled={disabled || uploading}
          onClick={() => inputRef.current?.click()}
          title="Upload images (or drop them here)"
        >
          {uploading ? '…' : '+'}
        </button>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          handleFiles(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
      {error && <div className="field-error">{error}</div>}
      {assets.length === 0 && <div className="asset-picker-empty">No images yet. Upload one with +, or drop files here.</div>}
    </div>
  );
};

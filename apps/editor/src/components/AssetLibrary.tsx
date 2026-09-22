import React, { useRef, useState } from 'react';
import { assetThumbUrl, deleteAsset, updateAsset, type Asset } from '../api/client';

interface Props {
  projectId: string;
  assets: Asset[];
  onUpload: (files: File[]) => Promise<Asset[]>;
  onChanged: () => void;
  onClose: () => void;
  autoDescribe: boolean;
  onToggleAutoDescribe: (value: boolean) => void;
  describingIds: string[];
  onDescribe: (assetId: string, overwrite: boolean) => Promise<void>;
}

const formatBytes = (n?: number) =>
  n === undefined ? '' : n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;

const AssetCard: React.FC<{
  projectId: string;
  asset: Asset;
  onChanged: () => void;
  describing: boolean;
  onDescribe: (assetId: string, overwrite: boolean) => Promise<void>;
}> = ({ projectId, asset, onChanged, describing, onDescribe }) => {
  const [name, setName] = useState(asset.name);
  const [description, setDescription] = useState(asset.description ?? '');
  const [error, setError] = useState<string | null>(null);
  const [usedBy, setUsedBy] = useState<string[] | null>(null);

  const save = (patch: { name?: string; description?: string }) =>
    updateAsset(projectId, asset.id, patch)
      .then(onChanged)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

  const describe = () =>
    onDescribe(asset.id, true).catch((e) => setError(e instanceof Error ? e.message : String(e)));

  const remove = async (force: boolean) => {
    try {
      const result = await deleteAsset(projectId, asset.id, force);
      if (result.deleted) onChanged();
      else setUsedBy(result.markers);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="asset-card">
      <img src={assetThumbUrl(projectId, asset)} alt={asset.name} />
      <div className="asset-card-body">
        <input
          className="field-input"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== asset.name && save({ name })}
          aria-label="image name"
        />
        <textarea
          className="field-textarea"
          rows={2}
          value={description}
          maxLength={500}
          placeholder="Describe it so Claude knows when to use it (e.g. 'company logo, white on transparent')"
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => description !== (asset.description ?? '') && save({ description })}
          aria-label="image description"
        />
        <div className="asset-card-meta">
          {asset.kind === 'generated' ? 'AI-generated' : 'Uploaded'}
          {asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : ''}
          {asset.bytes ? ` · ${formatBytes(asset.bytes)}` : ''}
        </div>
        {error && <div className="field-error">{error}</div>}
        {usedBy ? (
          <div className="asset-card-confirm">
            <span>
              Used by {usedBy.join(', ')}. Delete anyway? It is detached from those markers, and their code stops finding the image.
            </span>
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <button
                type="button"
                className="btn btn-sm"
                style={{ borderColor: 'var(--error)', color: 'var(--error)' }}
                onClick={() => remove(true)}
              >
                Delete
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setUsedBy(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="btn btn-sm"
              disabled={describing}
              onClick={describe}
              title="Have Claude look at the image and write a description (replaces the current one)"
            >
              {describing ? 'Describing…' : asset.description ? 'Re-describe with Claude' : 'Describe with Claude'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => remove(false)}>
              Delete
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export const AssetLibrary: React.FC<Props> = ({
  projectId,
  assets,
  onUpload,
  onChanged,
  onClose,
  autoDescribe,
  onToggleAutoDescribe,
  describingIds,
  onDescribe,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      await onUpload(files);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal"
        role="dialog"
        aria-label="Image library"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          handleFiles(Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/')));
        }}
      >
        <div className="modal-header">
          <h3 className="inspector-heading" style={{ margin: 0 }}>
            Image library
          </h3>
          <div style={{ flex: 1 }} />
          <button type="button" className="btn btn-primary btn-sm" disabled={uploading} onClick={() => inputRef.current?.click()}>
            {uploading ? 'Uploading…' : 'Upload images'}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            Close
          </button>
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
        </div>
        <div className="panel-hint">
          Upload logos, screenshots or photos once, then attach them to any marker. Claude looks at attached images and decides how to
          use them; unattached ones stay available to it as optional context. PNG, JPEG, GIF or WebP up to 10 MB. Drop files anywhere
          here.
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--text-muted)', marginTop: 8 }}>
          <input type="checkbox" checked={autoDescribe} onChange={(e) => onToggleAutoDescribe(e.target.checked)} />
          Describe new images automatically with Claude (a short, cheap call per upload). Descriptions help Claude, and the planner, know when to
          use an image.
        </label>
        {error && <div className="field-error">{error}</div>}
        {assets.length === 0 ? (
          <div className="inspector-empty">No images yet.</div>
        ) : (
          <div className="asset-library-grid">
            {assets.map((a) => (
              <AssetCard
                key={`${a.id}:${a.name}:${a.description ?? ''}`}
                projectId={projectId}
                asset={a}
                onChanged={onChanged}
                describing={describingIds.includes(a.id)}
                onDescribe={onDescribe}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

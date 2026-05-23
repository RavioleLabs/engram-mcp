// src/client/src/pages/ViewEditor.tsx
import { useParams } from 'react-router-dom';

export default function ViewEditor() {
  const { id } = useParams();
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">View Editor: {id}</h1>
      <p className="text-zinc-500">
        TODO: filter/sort/group/layout builder. For v1 ship, views can be created via the API and
        edited as JSON.
      </p>
    </div>
  );
}

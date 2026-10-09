import { Link } from 'react-router-dom';
import { EmptyState } from '../components/ui.jsx';

export default function NotFound() {
  return (
    <div className="page">
      <EmptyState title="There’s no page here" action={<Link to="/" className="btn btn-primary">Go home</Link>}>
        The link may be mistyped, or the page may have moved.
      </EmptyState>
    </div>
  );
}

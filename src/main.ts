import './style.css';
import { renderHome } from './home';

const root = document.getElementById('app');
if (root) {
    root.appendChild(renderHome());
}

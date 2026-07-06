import { registerRootComponent } from 'expo';
import App from './App';

// Registers the "CarnetQuickIdea" headless JS task (B5) so the notification
// inline-reply action can capture an idea with the app closed. Side-effect
// import — must run before any headless task can be dispatched.
import './src/lib/registerQuickIdeaTask';

registerRootComponent(App);

// The desktop browser controller: the Resona Box website's look. The App's controls live in ../shared/profile.js.
import {profile} from '../shared/profile.js';
import {mount} from '../shared/ui.js';
document.querySelector('#brand-name').textContent = profile.name;
mount(profile, 'web');

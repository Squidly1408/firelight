<p align="center"><img src="assets/banner.png" alt="Firelight" width="100%"></p>

<p align="center"><img alt="HTML5" src="https://img.shields.io/badge/HTML5-E34F26?logo=html5&logoColor=white"> <img alt="CSS3" src="https://img.shields.io/badge/CSS3-1572B6?logo=css3&logoColor=white"> <img alt="JavaScript" src="https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=black"> <img alt="No build step" src="https://img.shields.io/badge/build-none-brightgreen"> <img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg"></p>

A full-screen fire simulation to sit and watch. Heat rises, swirls and cools into flickering flames, logs glow and crack into embers, and sparks ride the air. It has a firefighter twist: tap and hold to spray water and put the fire out, then hold again to strike a match and bring it back.

<p align="center"><img src="assets/screenshot.png" alt="Firelight screenshot" width="85%"></p>

## Features

- Grid-based heat and smoke simulation with sparks, embers and flickering firelight on the stones
- Tap and hold to hose the fire out, with steam, smouldering embers and soaked wood that relights slower
- Hold again to relight: sparks, catch, then spread
- Tap to poke the fire, double-tap to throw on another log
- Crackling sound synthesised with the Web Audio API (muted by default)
- Intensity slider, fullscreen and screen wake lock; drops resolution automatically on slow devices

## Getting started

No build step and no dependencies. Clone the repo and open `index.html`, or serve the folder locally:

```bash
git clone https://github.com/Squidly1408/firelight.git
cd firelight
python -m http.server 5531
```

Then visit http://localhost:5531.

## Project structure

| File | Purpose |
|---|---|
| `index.html` | Page and controls |
| `app.js` | Fire simulation, rendering and input |
| `audio.js` | Procedural crackle and hiss sounds |
| `style.css` | Styles |
| `assets/` | Logo and README images |

## Built with

HTML, CSS, JavaScript (Canvas 2D, Web Audio API, Screen Wake Lock API)

## Limitations

- Side-on 2D fire with up to 7 logs; logs never burn away completely
- Not yet tested live on a real phone, so frame rate on low-end devices is unverified

## License

Released under the [MIT License](LICENSE).

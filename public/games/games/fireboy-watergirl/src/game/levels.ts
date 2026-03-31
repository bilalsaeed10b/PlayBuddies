// Bilal Saeed 1230
import { Level } from '../types';

export const DEFAULT_LEVELS: Level[] = [
  {
    "id": 1,
    "name": "The Beginning",
    "fireStart": {
      "x": 50,
      "y": 500
    },
    "waterStart": {
      "x": 100,
      "y": 500
    },
    "entities": [
      {
        "id": "floor",
        "x": 0,
        "y": 550,
        "width": 800,
        "height": 50,
        "type": "platform"
      },
      {
        "id": "wall-l",
        "x": 0,
        "y": 0,
        "width": 20,
        "height": 600,
        "type": "platform"
      },
      {
        "id": "wall-r",
        "x": 780,
        "y": 0,
        "width": 20,
        "height": 600,
        "type": "platform"
      },
      {
        "id": "fire-pool",
        "x": 200,
        "y": 540,
        "width": 100,
        "height": 10,
        "type": "hazard",
        "hazardType": "fire"
      },
      {
        "id": "water-pool",
        "x": 400,
        "y": 540,
        "width": 100,
        "height": 10,
        "type": "hazard",
        "hazardType": "water"
      },
      {
        "id": "p1",
        "x": 240,
        "y": 480,
        "width": 200,
        "height": 20,
        "type": "platform"
      },
      {
        "id": "door-fire",
        "x": 700,
        "y": 480,
        "width": 40,
        "height": 70,
        "type": "door",
        "color": "#ff4400"
      },
      {
        "id": "door-water",
        "x": 650,
        "y": 480,
        "width": 40,
        "height": 70,
        "type": "door",
        "color": "#00ccff"
      },
      {
        "id": "gem-1",
        "x": 350,
        "y": 430,
        "width": 20,
        "height": 20,
        "type": "gem",
        "color": "#ff4400"
      },
      {
        "id": "gem-2",
        "x": 400,
        "y": 430,
        "width": 20,
        "height": 20,
        "type": "gem",
        "color": "#00ccff"
      }
    ]
  },
  {
    "id": 2,
    "name": "Cooperation",
    "fireStart": {
      "x": 50,
      "y": 500
    },
    "waterStart": {
      "x": 74.5,
      "y": 490
    },
    "entities": [
      {
        "id": "floor",
        "x": 0,
        "y": 550,
        "width": 800,
        "height": 50,
        "type": "platform"
      },
      {
        "id": "p-mid",
        "x": 0,
        "y": 350,
        "width": 400,
        "height": 20,
        "type": "platform"
      },
      {
        "id": "m-p1",
        "x": 443,
        "y": 436,
        "width": 100,
        "height": 20,
        "type": "moving-platform",
        "startPos": {
          "x": 443,
          "y": 436
        },
        "endPos": {
          "x": 443,
          "y": 436
        },
        "speed": 2,
        "active": false
      },
      {
        "id": "acid-pool",
        "x": 200,
        "y": 540,
        "width": 400,
        "height": 10,
        "type": "hazard",
        "hazardType": "acid"
      },
      {
        "id": "door-fire",
        "x": 700,
        "y": 130,
        "width": 40,
        "height": 70,
        "type": "door",
        "color": "#ff4400"
      },
      {
        "id": "door-water",
        "x": 650,
        "y": 130,
        "width": 40,
        "height": 70,
        "type": "door",
        "color": "#00ccff"
      },
      {
        "id": "p-top",
        "x": 600,
        "y": 200,
        "width": 200,
        "height": 20,
        "type": "platform"
      },
      {
        "id": "gem-3",
        "x": 450,
        "y": 400,
        "width": 20,
        "height": 20,
        "type": "gem",
        "color": "#ff4400"
      },
      {
        "id": "gem-4",
        "x": 500,
        "y": 150,
        "width": 20,
        "height": 20,
        "type": "gem",
        "color": "#00ccff"
      },
      {
        "id": "blekgkzvr",
        "x": 251.5,
        "y": 477,
        "width": 127,
        "height": 20,
        "type": "moving-platform",
        "shape": "rect",
        "startPos": {
          "x": 251.5,
          "y": 477
        },
        "endPos": {
          "x": 251.5,
          "y": 477
        },
        "speed": 2
      },
      {
        "id": "ftbbnhqu0",
        "x": 295.5,
        "y": 274,
        "width": 56,
        "height": 57,
        "type": "platform",
        "shape": "circle"
      },
      {
        "id": "v5s6ovdd7",
        "x": 368.5,
        "y": 202,
        "width": 44,
        "height": 62,
        "type": "platform",
        "shape": "circle"
      },
      {
        "id": "s23v8hiz9",
        "x": 448.5,
        "y": 188,
        "width": 40,
        "height": 40,
        "type": "platform",
        "shape": "circle"
      },
      {
        "id": "xmo798k9n",
        "x": 530.5,
        "y": 202,
        "width": 40,
        "height": 10,
        "type": "hazard",
        "shape": "rect",
        "hazardType": "fire"
      }
    ]
  },
  {
    "id": 3,
    "name": "The Pit",
    "fireStart": {
      "x": 50,
      "y": 100
    },
    "waterStart": {
      "x": 100,
      "y": 100
    },
    "entities": [
      {
        "id": "floor",
        "x": 0,
        "y": 550,
        "width": 800,
        "height": 50,
        "type": "platform"
      },
      {
        "id": "p1",
        "x": 0,
        "y": 150,
        "width": 200,
        "height": 20,
        "type": "platform"
      },
      {
        "id": "p2",
        "x": 300,
        "y": 250,
        "width": 200,
        "height": 20,
        "type": "platform"
      },
      {
        "id": "p3",
        "x": 601,
        "y": 354,
        "width": 200,
        "height": 20,
        "type": "platform"
      },
      {
        "id": "acid-1",
        "x": 200,
        "y": 540,
        "width": 100,
        "height": 10,
        "type": "hazard",
        "hazardType": "acid"
      },
      {
        "id": "fire-1",
        "x": 300,
        "y": 540,
        "width": 100,
        "height": 10,
        "type": "hazard",
        "hazardType": "fire"
      },
      {
        "id": "water-1",
        "x": 400,
        "y": 540,
        "width": 100,
        "height": 10,
        "type": "hazard",
        "hazardType": "water"
      },
      {
        "id": "btn-1",
        "x": 700,
        "y": 320,
        "width": 30,
        "height": 10,
        "type": "pressure-plate",
        "targetId": "lift-1"
      },
      {
        "id": "lift-1",
        "x": 437,
        "y": 332,
        "width": 100,
        "height": 20,
        "type": "moving-platform",
        "startPos": {
          "x": 217,
          "y": 472
        },
        "endPos": {
          "x": 437,
          "y": 332
        },
        "speed": 5,
        "active": false,
        "patrol": true
      },
      {
        "id": "door-fire",
        "x": 709,
        "y": 478.5,
        "width": 40,
        "height": 70,
        "type": "door",
        "color": "#ff4400"
      },
      {
        "id": "door-water",
        "x": 649,
        "y": 478.5,
        "width": 40,
        "height": 70,
        "type": "door",
        "color": "#00ccff"
      },
      {
        "id": "gem-5",
        "x": 350,
        "y": 200,
        "width": 20,
        "height": 20,
        "type": "gem",
        "color": "#ff4400"
      },
      {
        "id": "gem-6",
        "x": 650,
        "y": 300,
        "width": 20,
        "height": 20,
        "type": "gem",
        "color": "#00ccff"
      },
      {
        "id": "4t69va0zw",
        "x": 363.5,
        "y": 239,
        "width": 40,
        "height": 10,
        "type": "hazard",
        "shape": "rect",
        "hazardType": "fire"
      },
      {
        "id": "fche8unj4",
        "x": 648.5,
        "y": 337,
        "width": 41,
        "height": 20,
        "type": "hazard",
        "shape": "rect",
        "hazardType": "water",
        "hidden": false
      },
      {
        "id": "hh8zpjrlh",
        "x": 520,
        "y": 410,
        "width": 100,
        "height": 20,
        "type": "hazard",
        "shape": "rect",
        "active": false,
        "hazardType": "acid"
      }
    ],
    "worldSettings": {
      "darkMode": false,
      "lightRadius": 150
    }
  },
  {
    "id": 4,
    "name": "The Switch",
    "fireStart": {
      "x": 50,
      "y": 500
    },
    "waterStart": {
      "x": 700,
      "y": 500
    },
    "entities": [
      {
        "id": "floor",
        "x": 0,
        "y": 550,
        "width": 800,
        "height": 50,
        "type": "platform"
      },
      {
        "id": "wall-l",
        "x": 0,
        "y": 0,
        "width": 20,
        "height": 600,
        "type": "platform"
      },
      {
        "id": "wall-r",
        "x": 780,
        "y": 0,
        "width": 20,
        "height": 600,
        "type": "platform"
      },
      {
        "id": "acid-mid",
        "x": 300,
        "y": 540,
        "width": 200,
        "height": 10,
        "type": "hazard",
        "hazardType": "acid"
      },
      {
        "id": "lever-fire",
        "x": 100,
        "y": 540,
        "width": 30,
        "height": 10,
        "type": "pressure-plate",
        "targetId": "plat-fire"
      },
      {
        "id": "lever-water",
        "x": 680,
        "y": 538,
        "width": 20,
        "height": 10,
        "type": "pressure-plate",
        "targetId": "plat-water"
      },
      {
        "id": "plat-fire",
        "x": 149,
        "y": 482,
        "width": 150,
        "height": 20,
        "type": "moving-platform",
        "startPos": {
          "x": 146,
          "y": 353
        },
        "endPos": {
          "x": 147,
          "y": 485
        },
        "speed": 1,
        "active": false
      },
      {
        "id": "plat-water",
        "x": 499,
        "y": 484,
        "width": 150,
        "height": 20,
        "type": "moving-platform",
        "startPos": {
          "x": 499,
          "y": 344
        },
        "endPos": {
          "x": 499,
          "y": 484
        },
        "speed": 1,
        "active": false,
        "patrol": false
      },
      {
        "id": "top-l",
        "x": 24,
        "y": 149,
        "width": 200,
        "height": 20,
        "type": "platform"
      },
      {
        "id": "top-r",
        "x": 550,
        "y": 150,
        "width": 200,
        "height": 20,
        "type": "platform"
      },
      {
        "id": "door-fire",
        "x": 100,
        "y": 80,
        "width": 40,
        "height": 70,
        "type": "door",
        "color": "#ff4400"
      },
      {
        "id": "door-water",
        "x": 650,
        "y": 80,
        "width": 40,
        "height": 70,
        "type": "door",
        "color": "#00ccff"
      },
      {
        "id": "gem-7",
        "x": 394.5,
        "y": 250,
        "width": 20,
        "height": 20,
        "type": "gem",
        "color": "#ff4400"
      },
      {
        "id": "gem-8",
        "x": 394.5,
        "y": 350,
        "width": 20,
        "height": 20,
        "type": "gem",
        "color": "#00ccff"
      },
      {
        "id": "2id4rocio",
        "x": 364.5,
        "y": 478,
        "width": 80,
        "height": 20,
        "type": "moving-platform",
        "shape": "rect",
        "startPos": {
          "x": 364.5,
          "y": 218
        },
        "endPos": {
          "x": 364.5,
          "y": 478
        },
        "speed": 5,
        "patrol": true
      },
      {
        "id": "cmxdb0byd",
        "x": 282,
        "y": 180,
        "width": 40,
        "height": 40,
        "type": "platform",
        "shape": "circle",
        "active": false
      },
      {
        "id": "r8dl82zvl",
        "x": 482,
        "y": 180,
        "width": 40,
        "height": 40,
        "type": "platform",
        "shape": "circle",
        "active": false
      }
    ],
    "worldSettings": {
      "darkMode": false,
      "lightRadius": 150
    }
  },
  {
    "id": 5,
    "name": "Elemental Divide",
    "fireStart": {
      "x": 50,
      "y": 500
    },
    "waterStart": {
      "x": 50,
      "y": 250
    },
    "entities": [
      {
        "id": "floor",
        "x": 0,
        "y": 550,
        "width": 800,
        "height": 50,
        "type": "platform"
      },
      {
        "id": "mid-floor",
        "x": -140,
        "y": 300,
        "width": 800,
        "height": 20,
        "type": "platform",
        "hidden": false
      },
      {
        "id": "fire-hazard-1",
        "x": 200,
        "y": 540,
        "width": 110,
        "height": 10,
        "type": "hazard",
        "hazardType": "water"
      },
      {
        "id": "fire-hazard-2",
        "x": 450,
        "y": 540,
        "width": 110,
        "height": 10,
        "type": "hazard",
        "hazardType": "acid"
      },
      {
        "id": "fire-btn",
        "x": 167,
        "y": 288,
        "width": 30,
        "height": 10,
        "type": "pressure-plate",
        "targetId": "water-gate"
      },
      {
        "id": "water-hazard-1",
        "x": 200,
        "y": 290,
        "width": 150,
        "height": 10,
        "type": "hazard",
        "hazardType": "fire"
      },
      {
        "id": "water-hazard-2",
        "x": 450,
        "y": 290,
        "width": 110,
        "height": 10,
        "type": "hazard",
        "hazardType": "acid"
      },
      {
        "id": "water-gate",
        "x": 680,
        "y": 160,
        "width": 40,
        "height": 20,
        "type": "moving-platform",
        "startPos": {
          "x": 680,
          "y": 480
        },
        "endPos": {
          "x": 680,
          "y": 160
        },
        "speed": 5,
        "active": false
      },
      {
        "id": "climb-1",
        "x": 750,
        "y": 0,
        "width": 50,
        "height": 600,
        "type": "platform"
      },
      {
        "id": "door-fire",
        "x": 50,
        "y": 50,
        "width": 40,
        "height": 70,
        "type": "door",
        "color": "#ff4400"
      },
      {
        "id": "door-water",
        "x": 120,
        "y": 50,
        "width": 40,
        "height": 70,
        "type": "door",
        "color": "#00ccff"
      },
      {
        "id": "top-plat",
        "x": 0,
        "y": 120,
        "width": 200,
        "height": 20,
        "type": "platform"
      },
      {
        "id": "gem-9",
        "x": 300,
        "y": 450,
        "width": 20,
        "height": 20,
        "type": "gem",
        "color": "#ff4400"
      },
      {
        "id": "gem-10",
        "x": 300,
        "y": 200,
        "width": 20,
        "height": 20,
        "type": "gem",
        "color": "#00ccff"
      },
      {
        "id": "w5a02jlvd",
        "x": 220,
        "y": 140,
        "width": 60,
        "height": 20,
        "type": "moving-platform",
        "shape": "rect",
        "active": false,
        "startPos": {
          "x": 460,
          "y": 240
        },
        "endPos": {
          "x": 220,
          "y": 140
        },
        "speed": 5,
        "patrol": true
      },
      {
        "id": "6o1se7ahx",
        "x": 300,
        "y": 190,
        "width": 60,
        "height": 10,
        "type": "hazard",
        "hazardType": "fire",
        "rotating": true,
        "rotationSpeed": 5
      },
      {
        "id": "qi4w4fih8",
        "x": 220,
        "y": 210,
        "width": 40,
        "height": 40,
        "type": "platform",
        "shape": "triangle",
        "active": false,
        "rotation": 24.05611363728449
      }
    ],
    "worldSettings": {
      "darkMode": false,
      "lightRadius": 150
    }
  },
  {
    "id": 6,
    "name": "The Gauntlet",
    "fireStart": {
      "x": 50,
      "y": 500
    },
    "waterStart": {
      "x": 100,
      "y": 500
    },
    "entities": [
      {
        "id": "floor",
        "x": 0,
        "y": 550,
        "width": 800,
        "height": 50,
        "type": "platform"
      },
      {
        "id": "acid-main",
        "x": 150,
        "y": 540,
        "width": 500,
        "height": 10,
        "type": "hazard",
        "hazardType": "acid"
      },
      {
        "id": "p1",
        "x": 200,
        "y": 450,
        "width": 60,
        "height": 20,
        "type": "platform"
      },
      {
        "id": "p2",
        "x": 350,
        "y": 400,
        "width": 60,
        "height": 20,
        "type": "platform"
      },
      {
        "id": "p3",
        "x": 460,
        "y": 450,
        "width": 60,
        "height": 20,
        "type": "platform"
      },
      {
        "id": "mp1",
        "x": 590,
        "y": 200,
        "width": 80,
        "height": 20,
        "type": "moving-platform",
        "startPos": {
          "x": 590,
          "y": 200
        },
        "endPos": {
          "x": 590,
          "y": 500
        },
        "speed": 5,
        "active": true,
        "patrol": true
      },
      {
        "id": "mp2",
        "x": 220,
        "y": 220,
        "width": 100,
        "height": 20,
        "type": "moving-platform",
        "startPos": {
          "x": 220,
          "y": 220
        },
        "endPos": {
          "x": 500,
          "y": 220
        },
        "speed": 6,
        "active": true,
        "patrol": true
      },
      {
        "id": "fire-top",
        "x": 317,
        "y": 210,
        "width": 80,
        "height": 10,
        "type": "hazard",
        "hazardType": "fire"
      },
      {
        "id": "water-top",
        "x": 400,
        "y": 208,
        "width": 80,
        "height": 10,
        "type": "hazard",
        "hazardType": "water"
      },
      {
        "id": "door-fire",
        "x": 50,
        "y": 130,
        "width": 40,
        "height": 70,
        "type": "door",
        "color": "#ff4400"
      },
      {
        "id": "door-water",
        "x": 100,
        "y": 130,
        "width": 40,
        "height": 70,
        "type": "door",
        "color": "#00ccff"
      },
      {
        "id": "final-plat",
        "x": 0,
        "y": 200,
        "width": 200,
        "height": 20,
        "type": "platform"
      },
      {
        "id": "gem-11",
        "x": 440,
        "y": 150,
        "width": 20,
        "height": 20,
        "type": "gem",
        "color": "#ff4400"
      },
      {
        "id": "gem-12",
        "x": 340,
        "y": 150,
        "width": 20,
        "height": 20,
        "type": "gem",
        "color": "#00ccff"
      }
    ],
    "worldSettings": {
      "darkMode": false,
      "lightRadius": 170,
      "backgroundTheme": "default"
    }
  },
  {
    "id": 7,
    "name": "Symmetry",
    "fireStart": {
      "x": 50,
      "y": 500
    },
    "waterStart": {
      "x": 720,
      "y": 500
    },
    "entities": [
      {
        "id": "floor",
        "x": 0,
        "y": 550,
        "width": 800,
        "height": 50,
        "type": "platform"
      },
      {
        "id": "p1",
        "x": 200,
        "y": 400,
        "width": 100,
        "height": 20,
        "type": "platform"
      },
      {
        "id": "p2",
        "x": 500,
        "y": 400,
        "width": 100,
        "height": 20,
        "type": "platform"
      },
      {
        "id": "fire-1",
        "x": 200,
        "y": 390,
        "width": 100,
        "height": 10,
        "type": "hazard",
        "hazardType": "water"
      },
      {
        "id": "water-1",
        "x": 500,
        "y": 390,
        "width": 100,
        "height": 10,
        "type": "hazard",
        "hazardType": "fire"
      },
      {
        "id": "door-fire",
        "x": 410,
        "y": 480,
        "width": 40,
        "height": 70,
        "type": "door",
        "color": "#ff4400"
      },
      {
        "id": "door-water",
        "x": 350,
        "y": 480,
        "width": 40,
        "height": 70,
        "type": "door",
        "color": "#00ccff"
      },
      {
        "id": "bzevsva8k",
        "x": 600,
        "y": 400,
        "width": 46,
        "height": 13,
        "type": "platform",
        "shape": "rect",
        "active": false
      },
      {
        "id": "6igc7maad",
        "x": 740,
        "y": 460,
        "width": 46,
        "height": 13,
        "type": "platform",
        "shape": "rect",
        "active": false
      },
      {
        "id": "oocyy33ny",
        "x": 740,
        "y": 340,
        "width": 46,
        "height": 13,
        "type": "platform",
        "shape": "rect",
        "active": false
      },
      {
        "id": "yqgt4j502",
        "x": 620,
        "y": 280,
        "width": 46,
        "height": 13,
        "type": "platform",
        "shape": "rect",
        "active": false
      },
      {
        "id": "71s4a07pu",
        "x": 347,
        "y": 340,
        "width": 100,
        "height": 10,
        "type": "hazard",
        "shape": "rect",
        "active": false,
        "hazardType": "acid"
      },
      {
        "id": "qjt1sn8gm",
        "x": 20,
        "y": 460,
        "width": 46,
        "height": 13,
        "type": "platform",
        "shape": "rect",
        "active": false,
        "rotation": 0
      },
      {
        "id": "bivvzqjtq",
        "x": 154,
        "y": 400,
        "width": 46,
        "height": 13,
        "type": "platform",
        "shape": "rect",
        "active": false,
        "rotation": 0
      },
      {
        "id": "97gpf3bkq",
        "x": 140,
        "y": 280,
        "width": 46,
        "height": 13,
        "type": "platform",
        "shape": "rect",
        "active": false,
        "rotation": 0
      },
      {
        "id": "f04sf9ilm",
        "x": 20,
        "y": 340,
        "width": 46,
        "height": 13,
        "type": "platform",
        "shape": "rect",
        "active": false
      },
      {
        "id": "x4ho29bfn",
        "x": 280,
        "y": 411,
        "width": 40,
        "height": 40,
        "type": "cannon",
        "shape": "rect",
        "active": false,
        "rotation": 90,
        "fireRate": 60,
        "projectileSpeed": 5,
        "rotating": false,
        "rotationSpeed": 1,
        "cannonType": "laser",
        "endPos": {
          "x": 300,
          "y": 560
        }
      },
      {
        "id": "osyhza1k2",
        "x": 493,
        "y": 413,
        "width": 40,
        "height": 40,
        "type": "cannon",
        "shape": "rect",
        "active": false,
        "rotation": 90,
        "fireRate": 20,
        "projectileSpeed": 25,
        "rotating": false,
        "rotationSpeed": 1,
        "cannonType": "laser",
        "endPos": {
          "x": 513,
          "y": 560.1927670899569
        }
      }
    ],
    "worldSettings": {
      "darkMode": false,
      "lightRadius": 270,
      "backgroundTheme": "neon"
    }
  },
  {
    "id": 8,
    "name": "The Climb",
    "fireStart": {
      "x": 50,
      "y": 500
    },
    "waterStart": {
      "x": 100,
      "y": 500
    },
    "entities": [
      {
        "id": "floor",
        "x": 0,
        "y": 550,
        "width": 800,
        "height": 50,
        "type": "platform"
      },
      {
        "id": "p1",
        "x": 200,
        "y": 450,
        "width": 100,
        "height": 20,
        "type": "platform"
      },
      {
        "id": "p2",
        "x": 400,
        "y": 350,
        "width": 100,
        "height": 20,
        "type": "platform"
      },
      {
        "id": "p3",
        "x": 200,
        "y": 250,
        "width": 100,
        "height": 20,
        "type": "platform"
      },
      {
        "id": "p4",
        "x": 400,
        "y": 150,
        "width": 100,
        "height": 20,
        "type": "platform"
      },
      {
        "id": "door-fire",
        "x": 410,
        "y": 80,
        "width": 40,
        "height": 70,
        "type": "door",
        "color": "#ff4400"
      },
      {
        "id": "door-water",
        "x": 450,
        "y": 80,
        "width": 40,
        "height": 70,
        "type": "door",
        "color": "#00ccff"
      }
    ]
  },
  {
    "id": 9,
    "name": "Acid Maze",
    "fireStart": {
      "x": 50,
      "y": 500
    },
    "waterStart": {
      "x": 100,
      "y": 500
    },
    "entities": [
      {
        "id": "floor",
        "x": 0,
        "y": 550,
        "width": 800,
        "height": 50,
        "type": "platform"
      },
      {
        "id": "acid-1",
        "x": 200,
        "y": 540,
        "width": 400,
        "height": 10,
        "type": "hazard",
        "hazardType": "acid"
      },
      {
        "id": "p1",
        "x": 250,
        "y": 450,
        "width": 50,
        "height": 20,
        "type": "platform"
      },
      {
        "id": "p2",
        "x": 350,
        "y": 350,
        "width": 50,
        "height": 20,
        "type": "platform"
      },
      {
        "id": "p3",
        "x": 450,
        "y": 450,
        "width": 50,
        "height": 20,
        "type": "platform"
      },
      {
        "id": "door-fire",
        "x": 700,
        "y": 480,
        "width": 40,
        "height": 70,
        "type": "door",
        "color": "#ff4400"
      },
      {
        "id": "door-water",
        "x": 750,
        "y": 480,
        "width": 40,
        "height": 70,
        "type": "door",
        "color": "#00ccff"
      }
    ]
  },
  {
    "id": 10,
    "name": "Double Trouble",
    "fireStart": {
      "x": 50,
      "y": 500
    },
    "waterStart": {
      "x": 100,
      "y": 500
    },
    "entities": [
      {
        "id": "floor",
        "x": 0,
        "y": 550,
        "width": 800,
        "height": 50,
        "type": "platform"
      },
      {
        "id": "fire-1",
        "x": 200,
        "y": 540,
        "width": 100,
        "height": 10,
        "type": "hazard",
        "hazardType": "fire"
      },
      {
        "id": "water-1",
        "x": 400,
        "y": 540,
        "width": 100,
        "height": 10,
        "type": "hazard",
        "hazardType": "water"
      },
      {
        "id": "acid-1",
        "x": 600,
        "y": 540,
        "width": 100,
        "height": 10,
        "type": "hazard",
        "hazardType": "acid"
      },
      {
        "id": "door-fire",
        "x": 700,
        "y": 480,
        "width": 40,
        "height": 70,
        "type": "door",
        "color": "#ff4400"
      },
      {
        "id": "door-water",
        "x": 750,
        "y": 480,
        "width": 40,
        "height": 70,
        "type": "door",
        "color": "#00ccff"
      }
    ]
  },
  {
    "id": 11,
    "name": "The Bridge",
    "fireStart": {
      "x": 50,
      "y": 500
    },
    "waterStart": {
      "x": 100,
      "y": 500
    },
    "entities": [
      {
        "id": "floor",
        "x": 0,
        "y": 550,
        "width": 800,
        "height": 50,
        "type": "platform"
      },
      {
        "id": "btn-1",
        "x": 200,
        "y": 540,
        "width": 30,
        "height": 10,
        "type": "pressure-plate",
        "targetId": "bridge"
      },
      {
        "id": "bridge",
        "x": 300,
        "y": 400,
        "width": 200,
        "height": 20,
        "type": "moving-platform",
        "startPos": {
          "x": 300,
          "y": 400
        },
        "endPos": {
          "x": 300,
          "y": 400
        },
        "speed": 0,
        "active": false
      },
      {
        "id": "door-fire",
        "x": 700,
        "y": 480,
        "width": 40,
        "height": 70,
        "type": "door",
        "color": "#ff4400"
      },
      {
        "id": "door-water",
        "x": 750,
        "y": 480,
        "width": 40,
        "height": 70,
        "type": "door",
        "color": "#00ccff"
      }
    ]
  },
  {
    "id": 12,
    "name": "Leap of Faith",
    "fireStart": {
      "x": 20,
      "y": 120
    },
    "waterStart": {
      "x": 60,
      "y": 120
    },
    "entities": [
      {
        "id": "floor",
        "x": 0,
        "y": 200,
        "width": 140,
        "height": 400,
        "type": "platform",
        "hidden": false,
        "locked": false
      },
      {
        "id": "floor-end",
        "x": 680,
        "y": 520,
        "width": 120,
        "height": 80,
        "type": "platform"
      },
      {
        "id": "acid-pit",
        "x": 140,
        "y": 540,
        "width": 540,
        "height": 60,
        "type": "hazard",
        "hazardType": "acid"
      },
      {
        "id": "door-fire",
        "x": 700,
        "y": 440,
        "width": 40,
        "height": 70,
        "type": "door",
        "color": "#ff4400"
      },
      {
        "id": "door-water",
        "x": 750,
        "y": 440,
        "width": 40,
        "height": 70,
        "type": "door",
        "color": "#00ccff"
      },
      {
        "id": "8df2ceulk",
        "x": 140,
        "y": 410,
        "width": 540,
        "height": 20,
        "type": "pressure-plate",
        "shape": "rect",
        "active": false,
        "targetId": "v22klxzov",
        "hidden": true,
        "plateType": "toggle"
      },
      {
        "id": "v22klxzov",
        "x": 140,
        "y": 606,
        "width": 540,
        "height": 20,
        "type": "moving-platform",
        "shape": "rect",
        "active": false,
        "startPos": {
          "x": 140,
          "y": 607
        },
        "endPos": {
          "x": 140,
          "y": 520
        },
        "speed": 50
      }
    ],
    "worldSettings": {
      "darkMode": false,
      "lightRadius": 150
    }
  },
  {
    "id": 13,
    "name": "Synchronized",
    "fireStart": {
      "x": 50,
      "y": 500
    },
    "waterStart": {
      "x": 100,
      "y": 500
    },
    "entities": [
      {
        "id": "floor",
        "x": 0,
        "y": 550,
        "width": 800,
        "height": 50,
        "type": "platform"
      },
      {
        "id": "mp1",
        "x": 200,
        "y": 500,
        "width": 100,
        "height": 20,
        "type": "moving-platform",
        "startPos": {
          "x": 200,
          "y": 500
        },
        "endPos": {
          "x": 200,
          "y": 200
        },
        "speed": 2,
        "active": true
      },
      {
        "id": "mp2",
        "x": 500,
        "y": 500,
        "width": 100,
        "height": 20,
        "type": "moving-platform",
        "startPos": {
          "x": 500,
          "y": 500
        },
        "endPos": {
          "x": 500,
          "y": 200
        },
        "speed": 2,
        "active": true
      },
      {
        "id": "door-fire",
        "x": 700,
        "y": 480,
        "width": 40,
        "height": 70,
        "type": "door",
        "color": "#ff4400"
      },
      {
        "id": "door-water",
        "x": 750,
        "y": 480,
        "width": 40,
        "height": 70,
        "type": "door",
        "color": "#00ccff"
      }
    ]
  },
  {
    "id": 14,
    "name": "The Maze",
    "fireStart": {
      "x": 50,
      "y": 500
    },
    "waterStart": {
      "x": 100,
      "y": 500
    },
    "entities": [
      {
        "id": "floor",
        "x": 0,
        "y": 550,
        "width": 800,
        "height": 50,
        "type": "platform"
      },
      {
        "id": "wall1",
        "x": 200,
        "y": 300,
        "width": 20,
        "height": 250,
        "type": "platform"
      },
      {
        "id": "wall2",
        "x": 400,
        "y": 0,
        "width": 20,
        "height": 250,
        "type": "platform"
      },
      {
        "id": "wall3",
        "x": 600,
        "y": 300,
        "width": 20,
        "height": 250,
        "type": "platform"
      },
      {
        "id": "door-fire",
        "x": 700,
        "y": 480,
        "width": 40,
        "height": 70,
        "type": "door",
        "color": "#ff4400"
      },
      {
        "id": "door-water",
        "x": 750,
        "y": 480,
        "width": 40,
        "height": 70,
        "type": "door",
        "color": "#00ccff"
      }
    ]
  },
  {
    "id": 15,
    "name": "Final Chamber",
    "fireStart": {
      "x": 50,
      "y": 500
    },
    "waterStart": {
      "x": 100,
      "y": 500
    },
    "entities": [
      {
        "id": "floor",
        "x": 0,
        "y": 550,
        "width": 800,
        "height": 50,
        "type": "platform"
      },
      {
        "id": "acid-all",
        "x": 150,
        "y": 540,
        "width": 500,
        "height": 10,
        "type": "hazard",
        "hazardType": "acid"
      },
      {
        "id": "p1",
        "x": 200,
        "y": 400,
        "width": 50,
        "height": 20,
        "type": "platform"
      },
      {
        "id": "p2",
        "x": 300,
        "y": 300,
        "width": 50,
        "height": 20,
        "type": "platform"
      },
      {
        "id": "p3",
        "x": 400,
        "y": 200,
        "width": 50,
        "height": 20,
        "type": "platform"
      },
      {
        "id": "p4",
        "x": 500,
        "y": 300,
        "width": 50,
        "height": 20,
        "type": "platform"
      },
      {
        "id": "p5",
        "x": 600,
        "y": 400,
        "width": 50,
        "height": 20,
        "type": "platform"
      },
      {
        "id": "door-fire",
        "x": 700,
        "y": 480,
        "width": 40,
        "height": 70,
        "type": "door",
        "color": "#ff4400"
      },
      {
        "id": "door-water",
        "x": 750,
        "y": 480,
        "width": 40,
        "height": 70,
        "type": "door",
        "color": "#00ccff"
      }
    ]
  }
];

export function getLevels(): Level[] {
  // Bilal Saeed 1230 - Bypass overrides to ensure new levels load
  return DEFAULT_LEVELS;
}
// Bilal Saeed 1230

// Browser bundle: exposes cytoscape globally with dagre layout
const cytoscape = require('cytoscape');
const dagre = require('dagre');
const cytoscapeDagre = require('cytoscape-dagre');

cytoscape.use(cytoscapeDagre);

window.cytoscape = cytoscape;

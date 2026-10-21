// A clearer OpenStreetMap France rendering, with a softer color treatment in style.css.
// Keep visible attribution and follow the provider's public, non-profit, moderate-traffic usage policy.
window.PACE_TILE={
  maxZoom:16,
  attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a> (ODbL) · <a href="https://www.openstreetmap.fr/open-data/">Tiles by OpenStreetMap France</a> (CC BY-SA)',
  layers:[
    {url:'https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png'}
  ]
};
// Adds the base layers to a map and returns the first (base) tile layer so callers can listen for tile errors.
window.addBaseMap=function(map){
  const T=window.PACE_TILE;
  let base=null;
  T.layers.forEach((l,i)=>{const layer=L.tileLayer(l.url,{maxZoom:T.maxZoom,maxNativeZoom:l.maxNativeZoom,attribution:i===0?T.attribution:''}).addTo(map);if(i===0)base=layer;});
  return base;
};

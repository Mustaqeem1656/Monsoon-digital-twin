import json, numpy as np, shapefile
from PIL import Image, ImageDraw
from scipy import ndimage
from global_land_mask import globe
TW,TH,B=8192,4096,2
landm=np.zeros((TH,TW),bool); lons=(np.arange(TW)+0.5)/TW*360-180
for r0 in range(0,TH,512):
    lat=90-(np.arange(r0,r0+512)+0.5)/TH*180; LA,LO=np.meshgrid(lat,lons,indexing='ij'); landm[r0:r0+512]=globe.is_land(np.clip(LA,-89.99,89.99),LO)
bl=Image.new('LA',(TW*B,TH*B),(0,0)); dr=ImageDraw.Draw(bl)
def ring(pts,a,w):
    pts=np.asarray(pts,float); x=(pts[:,0]+180)/360*TW*B; y=(90-pts[:,1])/180*TH*B; seg=[(x[0],y[0])]
    for i in range(1,len(pts)):
        if abs(x[i]-x[i-1])>TW*B/2:
            if len(seg)>1: dr.line(seg,fill=(255,a),width=w)
            seg=[]
        seg.append((x[i],y[i]))
    if len(seg)>1: dr.line(seg,fill=(255,a),width=w)
near={'Pakistan','Nepal','Bhutan','Bangladesh','Myanmar','Sri Lanka','China','Afghanistan',
      'Oman','United Arab Emirates','Qatar','Bahrain','Saudi Arabia','Yemen','Kuwait','Iraq','Iran','Jordan','Syria','Lebanon','Israel','Palestine'}
for f in json.load(open('/tmp/geo/countries_ind.geojson'))['features']:
    n=f['properties']['NAME']; g=f['geometry']; polys=g['coordinates'] if g['type']=='MultiPolygon' else [g['coordinates']]
    a,w=(250,4) if n=='India' else ((185,3) if n in near else (80,2))
    for p in polys:
        for rg in p: ring(rg,a,w)
sr=shapefile.Reader('/tmp/geo/Admin2')
for shp in sr.shapes():
    pts=np.asarray(shp.points); parts=list(shp.parts)+[len(pts)]
    for a0,b0 in zip(parts[:-1],parts[1:]):
        rg=pts[a0:b0]; rg=rg[::2] if len(rg)>6 else rg; ring(rg,120,2)
bl=bl.resize((TW,TH),Image.LANCZOS); ba=np.asarray(bl).copy()
ba[...,1]=(ba[...,1]*ndimage.binary_erosion(landm,iterations=2)).astype(np.uint8)
Image.fromarray(ba,'LA').save('/home/claude/monsoon-design/build/tex_borders2.png',optimize=True); print('ok')

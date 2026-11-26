"""RGB line texture: R = international borders, G = coastline (land/sea edge), B = Indian state lines."""
import json, numpy as np, shapefile
from PIL import Image, ImageDraw
from scipy import ndimage
from global_land_mask import globe
OUT='/home/claude/monsoon-design/build/'; TW,TH=8192,4096; B=2
landm=np.zeros((TH,TW),bool); lons=(np.arange(TW)+0.5)/TW*360-180
for r0 in range(0,TH,512):
    lat=90-(np.arange(r0,r0+512)+0.5)/TH*180; LA,LO=np.meshgrid(lat,lons,indexing='ij'); landm[r0:r0+512]=globe.is_land(np.clip(LA,-89.99,89.99),LO)
def layer():
    im=Image.new('L',(TW*B,TH*B),0); return im, ImageDraw.Draw(im)
def ring(dr,pts,a,w):
    pts=np.asarray(pts,float); x=(pts[:,0]+180)/360*TW*B; y=(90-pts[:,1])/180*TH*B; seg=[(x[0],y[0])]
    for i in range(1,len(pts)):
        if abs(x[i]-x[i-1])>TW*B/2:
            if len(seg)>1: dr.line(seg,fill=a,width=w)
            seg=[]
        seg.append((x[i],y[i]))
    if len(seg)>1: dr.line(seg,fill=a,width=w)
intl,di=layer(); st,ds=layer()
gj=json.load(open('/tmp/geo/countries_ind.geojson'))
for f in gj['features']:
    g=f['geometry']; polys=g['coordinates'] if g['type']=='MultiPolygon' else [g['coordinates']]
    for p in polys:
        for rg in p: ring(di,rg,255,5)
sr=shapefile.Reader('/tmp/geo/Admin2')
for shp in sr.shapes():
    pts=np.asarray(shp.points); parts=list(shp.parts)+[len(pts)]
    for a,b in zip(parts[:-1],parts[1:]):
        rg=pts[a:b]; rg=rg[::2] if len(rg)>6 else rg; ring(ds,rg,255,3)
inland=ndimage.binary_erosion(landm,iterations=2)
R=np.asarray(intl.resize((TW,TH),Image.LANCZOS)).astype(float)*inland
Bc=np.asarray(st.resize((TW,TH),Image.LANCZOS)).astype(float)*inland
edge=landm ^ ndimage.binary_erosion(landm)
G=ndimage.gaussian_filter(edge.astype(float),0.9); G=np.clip(G/G.max()*2.2,0,1)*255
Image.fromarray(np.stack([R,G,Bc],-1).clip(0,255).astype(np.uint8)).save(OUT+'tex_lines.png',optimize=True)
print('ok')

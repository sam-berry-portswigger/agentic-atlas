"""Local numeric projection and density clustering; no archive text or network."""
import json,sys

def main():
 import numpy as np
 import sklearn,umap
 from sklearn.preprocessing import normalize
 from sklearn.cluster import HDBSCAN
 request=json.load(sys.stdin)
 vectors=np.asarray(request['vectors'],dtype=np.float32)
 if vectors.ndim!=2 or not 3<=len(vectors)<=1800 or not np.isfinite(vectors).all():
  raise ValueError('Expected 3–1800 finite vectors of equal dimension.')
 vectors=normalize(vectors)
 if np.max(np.abs(vectors-vectors[0]))<1e-7:
  points=np.zeros((len(vectors),2)); labels=np.zeros(len(vectors),dtype=int)
 else:
  print(json.dumps({'type':'progress','done':50,'total':1000}),flush=True)
  points=umap.UMAP(n_neighbors=min(15,len(vectors)-1),n_components=2,min_dist=.08,metric='cosine',negative_sample_rate=30,random_state=42,n_jobs=1,init='random' if len(vectors)<5 else 'spectral').fit_transform(vectors)
  print(json.dumps({'type':'progress','done':900,'total':1000}),flush=True)
  labels=HDBSCAN(min_cluster_size=6,min_samples=3,cluster_selection_method='leaf',copy=True).fit_predict(points) if len(vectors)>=6 else np.full(len(vectors),-1)
 print(json.dumps({'type':'result','points':points.tolist(),'labels':labels.tolist(),'implementation':'umap-learn + scikit-learn','version':umap.__version__+' / '+sklearn.__version__}),flush=True)

if __name__=='__main__':
 try: main()
 except Exception as error:
  print(f'Map projection failed: {type(error).__name__}: {error}',file=sys.stderr);sys.exit(1)

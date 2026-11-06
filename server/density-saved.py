"""Cluster saved numeric coordinates without running a new projection."""
import json, sys
import numpy as np
from sklearn.cluster import HDBSCAN

points = np.asarray(json.load(sys.stdin)['vectors'], dtype=float)
if points.ndim != 2 or points.shape[1] != 2 or not np.isfinite(points).all():
    raise ValueError('Expected finite saved 2D coordinates.')
labels = HDBSCAN(min_cluster_size=6, min_samples=3, cluster_selection_method='leaf', copy=True).fit_predict(points)
print(json.dumps({'type':'result', 'points':points.tolist(), 'labels':labels.tolist()}), flush=True)

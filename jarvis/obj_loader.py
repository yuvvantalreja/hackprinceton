import numpy as np
from typing import List, Tuple, Optional
import os

class OBJLoader:
    """Loader for OBJ 3D model files"""
    
    def __init__(self):
        self.vertices = []
        self.faces = []
        self.normals = []
        self.texture_coords = []
        
    def load_obj(self, filepath: str) -> bool:
        """Load an OBJ file and parse its contents"""
        if not os.path.exists(filepath):
            print(f"Error: OBJ file not found: {filepath}")
            return False
            
        self.vertices = []
        self.faces = []
        self.normals = []
        self.texture_coords = []
        
        try:
            with open(filepath, 'r') as file:
                for line_num, line in enumerate(file):
                    line = line.strip()
                    if not line or line.startswith('#'):
                        continue
                        
                    parts = line.split()
                    if not parts:
                        continue
                        
                    if parts[0] == 'v':  # Vertex
                        if len(parts) >= 4:
                            vertex = [float(parts[1]), float(parts[2]), float(parts[3])]
                            self.vertices.append(vertex)
                            
                    elif parts[0] == 'vn':  # Vertex normal
                        if len(parts) >= 4:
                            normal = [float(parts[1]), float(parts[2]), float(parts[3])]
                            self.normals.append(normal)
                            
                    elif parts[0] == 'vt':  # Texture coordinate
                        if len(parts) >= 3:
                            tex_coord = [float(parts[1]), float(parts[2])]
                            self.texture_coords.append(tex_coord)
                            
                    elif parts[0] == 'f':  # Face
                        face_vertices = []
                        valid_face = True
                        for vertex_data in parts[1:]:
                            # Handle different face formats: v, v/vt, v/vt/vn, v//vn
                            vertex_indices = vertex_data.split('/')
                            try:
                                vertex_index = int(vertex_indices[0]) - 1  # OBJ indices start at 1
                                face_vertices.append(vertex_index)
                            except (ValueError, IndexError):
                                print(f"Warning: Invalid vertex index in face: {vertex_data}")
                                valid_face = False
                                break
                        
                        # Convert to triangles if necessary
                        if valid_face and len(face_vertices) >= 3:
                            # For quads and higher polygons, triangulate
                            for i in range(1, len(face_vertices) - 1):
                                triangle = [face_vertices[0], face_vertices[i], face_vertices[i + 1]]
                                # Only add triangle if all vertices are valid (will be checked later)
                                self.faces.append(triangle)
                                
        except Exception as e:
            print(f"Error loading OBJ file: {e}")
            return False
            
        # Validate and clean up faces
        self._validate_faces()
        
        print(f"Loaded OBJ: {len(self.vertices)} vertices, {len(self.faces)} faces")
        return True
        
    def _validate_faces(self) -> None:
        """Remove faces that reference invalid vertex indices"""
        if not self.faces or not self.vertices:
            return
            
        num_vertices = len(self.vertices)
        valid_faces = []
        invalid_count = 0
        
        for face in self.faces:
            valid_face = True
            for vertex_idx in face:
                if vertex_idx < 0 or vertex_idx >= num_vertices:
                    valid_face = False
                    invalid_count += 1
                    break
            
            if valid_face:
                valid_faces.append(face)
        
        if invalid_count > 0:
            print(f"Warning: Removed {invalid_count} faces with invalid vertex references")
            
        self.faces = valid_faces
        
    def get_vertices(self) -> np.ndarray:
        """Get vertices as numpy array"""
        return np.array(self.vertices, dtype=np.float32)
        
    def get_faces(self) -> np.ndarray:
        """Get faces as numpy array"""
        return np.array(self.faces, dtype=np.int32)
        
    def get_normals(self) -> np.ndarray:
        """Get normals as numpy array"""
        return np.array(self.normals, dtype=np.float32)
        
    def calculate_face_normals(self) -> np.ndarray:
        """Calculate face normals if not provided in OBJ file"""
        if len(self.vertices) == 0 or len(self.faces) == 0:
            return np.array([])
            
        vertices = self.get_vertices()
        faces = self.get_faces()
        face_normals = []
        num_vertices = len(vertices)
        
        for face in faces:
            if len(face) >= 3:
                # Check if all face indices are valid
                valid_face = True
                for idx in face[:3]:  # Only check first 3 vertices for triangle
                    if idx < 0 or idx >= num_vertices:
                        print(f"Warning: Face references invalid vertex index {idx} (max: {num_vertices-1})")
                        valid_face = False
                        break
                
                if not valid_face:
                    # Skip this face and use default normal
                    face_normals.append(np.array([0, 0, 1], dtype=np.float32))
                    continue
                
                v1 = vertices[face[0]]
                v2 = vertices[face[1]]
                v3 = vertices[face[2]]
                
                # Calculate normal using cross product
                edge1 = v2 - v1
                edge2 = v3 - v1
                normal = np.cross(edge1, edge2)
                
                # Normalize
                length = np.linalg.norm(normal)
                if length > 0:
                    normal = normal / length
                else:
                    normal = np.array([0, 0, 1])  # Default normal
                    
                face_normals.append(normal)
                
        return np.array(face_normals, dtype=np.float32)
        
    def get_bounding_box(self) -> Tuple[np.ndarray, np.ndarray]:
        """Get the bounding box of the model (min, max)"""
        if len(self.vertices) == 0:
            return np.array([0, 0, 0]), np.array([0, 0, 0])
            
        vertices = self.get_vertices()
        min_bounds = np.min(vertices, axis=0)
        max_bounds = np.max(vertices, axis=0)
        
        return min_bounds, max_bounds
        
    def normalize_model(self, target_size: float = 1.0) -> None:
        """Normalize the model to fit within a target size"""
        if len(self.vertices) == 0:
            return
            
        vertices = np.array(self.vertices)
        
        # Center the model
        center = np.mean(vertices, axis=0)
        vertices -= center
        
        # Scale to target size
        max_extent = np.max(np.abs(vertices))
        if max_extent > 0:
            scale_factor = target_size / max_extent
            vertices *= scale_factor
            
        self.vertices = vertices.tolist()

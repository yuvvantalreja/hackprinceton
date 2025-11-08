import numpy as np
import cv2
from typing import List, Tuple, Optional
import math

class Transform3D:
    """3D transformation matrix operations"""
    
    @staticmethod
    def translation_matrix(tx: float, ty: float, tz: float) -> np.ndarray:
        """Create a translation matrix"""
        return np.array([
            [1, 0, 0, tx],
            [0, 1, 0, ty],
            [0, 0, 1, tz],
            [0, 0, 0, 1]
        ], dtype=np.float32)
    
    @staticmethod
    def rotation_matrix_x(angle: float) -> np.ndarray:
        """Create rotation matrix around X axis"""
        cos_a, sin_a = math.cos(angle), math.sin(angle)
        return np.array([
            [1, 0, 0, 0],
            [0, cos_a, -sin_a, 0],
            [0, sin_a, cos_a, 0],
            [0, 0, 0, 1]
        ], dtype=np.float32)
    
    @staticmethod
    def rotation_matrix_y(angle: float) -> np.ndarray:
        """Create rotation matrix around Y axis"""
        cos_a, sin_a = math.cos(angle), math.sin(angle)
        return np.array([
            [cos_a, 0, sin_a, 0],
            [0, 1, 0, 0],
            [-sin_a, 0, cos_a, 0],
            [0, 0, 0, 1]
        ], dtype=np.float32)
    
    @staticmethod
    def rotation_matrix_z(angle: float) -> np.ndarray:
        """Create rotation matrix around Z axis"""
        cos_a, sin_a = math.cos(angle), math.sin(angle)
        return np.array([
            [cos_a, -sin_a, 0, 0],
            [sin_a, cos_a, 0, 0],
            [0, 0, 1, 0],
            [0, 0, 0, 1]
        ], dtype=np.float32)
    
    @staticmethod
    def scale_matrix(sx: float, sy: float, sz: float) -> np.ndarray:
        """Create a scale matrix"""
        return np.array([
            [sx, 0, 0, 0],
            [0, sy, 0, 0],
            [0, 0, sz, 0],
            [0, 0, 0, 1]
        ], dtype=np.float32)
    
    @staticmethod
    def perspective_projection(fov: float, aspect: float, near: float, far: float) -> np.ndarray:
        """Create perspective projection matrix"""
        f = 1.0 / math.tan(fov / 2.0)
        return np.array([
            [f / aspect, 0, 0, 0],
            [0, f, 0, 0],
            [0, 0, (far + near) / (near - far), (2 * far * near) / (near - far)],
            [0, 0, -1, 0]
        ], dtype=np.float32)
    
    @staticmethod
    def look_at(eye: np.ndarray, target: np.ndarray, up: np.ndarray) -> np.ndarray:
        """Create view matrix using look-at"""
        forward = target - eye
        forward = forward / np.linalg.norm(forward)
        
        right = np.cross(forward, up)
        right = right / np.linalg.norm(right)
        
        up = np.cross(right, forward)
        
        return np.array([
            [right[0], right[1], right[2], -np.dot(right, eye)],
            [up[0], up[1], up[2], -np.dot(up, eye)],
            [-forward[0], -forward[1], -forward[2], np.dot(forward, eye)],
            [0, 0, 0, 1]
        ], dtype=np.float32)


class Renderer3D:
    """3D renderer for OBJ models"""
    
    def __init__(self, width: int, height: int):
        self.width = width
        self.height = height
        self.fov = math.radians(60)  # 60 degree field of view
        self.near = 0.1
        self.far = 100.0
        
        # Camera setup
        self.camera_pos = np.array([0, 0, 5], dtype=np.float32)
        self.camera_target = np.array([0, 0, 0], dtype=np.float32)
        self.camera_up = np.array([0, 1, 0], dtype=np.float32)
        
        # Lighting
        self.light_dir = np.array([0.5, 0.5, 1.0], dtype=np.float32)
        self.light_dir = self.light_dir / np.linalg.norm(self.light_dir)
        
        # Matrices
        self.projection_matrix = Transform3D.perspective_projection(
            self.fov, width / height, self.near, self.far)
        self.view_matrix = Transform3D.look_at(
            self.camera_pos, self.camera_target, self.camera_up)
        
    def project_vertices(self, vertices: np.ndarray, model_matrix: np.ndarray) -> np.ndarray:
        """Project 3D vertices to 2D screen coordinates"""
        if len(vertices) == 0:
            return np.array([])
        
        # Add homogeneous coordinate
        vertices_4d = np.hstack([vertices, np.ones((vertices.shape[0], 1))])
        
        # Apply transformations: Model -> View -> Projection
        mvp_matrix = self.projection_matrix @ self.view_matrix @ model_matrix
        projected = vertices_4d @ mvp_matrix.T
        
        # Perspective divide
        projected[:, :3] /= projected[:, 3:4]
        
        # Convert to screen coordinates
        screen_coords = np.zeros((projected.shape[0], 2))
        screen_coords[:, 0] = (projected[:, 0] + 1) * self.width / 2
        screen_coords[:, 1] = (1 - projected[:, 1]) * self.height / 2
        
        return screen_coords.astype(np.int32)
    
    def calculate_lighting(self, normal: np.ndarray) -> float:
        """Calculate simple diffuse lighting"""
        # Normalize the normal vector
        if np.linalg.norm(normal) > 0:
            normal = normal / np.linalg.norm(normal)
        
        # Calculate dot product with light direction
        intensity = max(0.0, np.dot(normal, self.light_dir))
        
        # Add ambient lighting
        ambient = 0.3
        return min(1.0, ambient + intensity * 0.7)
    
    def render_wireframe(self, frame: np.ndarray, vertices: np.ndarray, faces: np.ndarray, 
                        model_matrix: np.ndarray, color: Tuple[int, int, int] = (255, 255, 255)) -> np.ndarray:
        """Render model as wireframe"""
        if len(vertices) == 0 or len(faces) == 0:
            return frame
        
        # Project vertices to screen space
        screen_coords = self.project_vertices(vertices, model_matrix)
        
        # Draw edges
        for face in faces:
            if len(face) >= 3:
                for i in range(len(face)):
                    start_idx = face[i]
                    end_idx = face[(i + 1) % len(face)]
                    
                    if start_idx < len(screen_coords) and end_idx < len(screen_coords):
                        start_point = tuple(screen_coords[start_idx])
                        end_point = tuple(screen_coords[end_idx])
                        
                        # Check if points are within screen bounds
                        if (0 <= start_point[0] < self.width and 0 <= start_point[1] < self.height and
                            0 <= end_point[0] < self.width and 0 <= end_point[1] < self.height):
                            cv2.line(frame, start_point, end_point, color, 1)
        
        return frame
    
    def render_solid(self, frame: np.ndarray, vertices: np.ndarray, faces: np.ndarray,
                    face_normals: np.ndarray, model_matrix: np.ndarray, 
                    color: Tuple[int, int, int] = (100, 150, 255)) -> np.ndarray:
        """Render model with solid faces and lighting"""
        if len(vertices) == 0 or len(faces) == 0:
            return frame
        
        # Project vertices to screen space
        screen_coords = self.project_vertices(vertices, model_matrix)
        
        # Transform normals (only rotation part of model matrix)
        rotation_matrix = model_matrix[:3, :3]
        if len(face_normals) > 0:
            transformed_normals = face_normals @ rotation_matrix.T
        else:
            transformed_normals = []
        
        # Draw faces with back-face culling and lighting
        for i, face in enumerate(faces):
            if len(face) >= 3:
                # Get screen coordinates for this face
                face_points = []
                valid_face = True
                
                for vertex_idx in face:
                    if vertex_idx < len(screen_coords):
                        point = screen_coords[vertex_idx]
                        # Basic bounds checking
                        if (-100 <= point[0] <= self.width + 100 and 
                            -100 <= point[1] <= self.height + 100):
                            face_points.append(point)
                        else:
                            valid_face = False
                            break
                    else:
                        valid_face = False
                        break
                
                if not valid_face or len(face_points) < 3:
                    continue
                
                # Back-face culling (simple version)
                if len(face_points) >= 3:
                    v1 = face_points[1] - face_points[0]
                    v2 = face_points[2] - face_points[0]
                    cross = v1[0] * v2[1] - v1[1] * v2[0]
                    
                    if cross > 0:  # Front-facing
                        # Calculate lighting
                        if i < len(transformed_normals):
                            lighting = self.calculate_lighting(transformed_normals[i])
                        else:
                            lighting = 0.7  # Default lighting
                        
                        # Apply lighting to color
                        lit_color = tuple(int(c * lighting) for c in color)
                        
                        # Draw filled triangle/polygon
                        points = np.array(face_points, dtype=np.int32)
                        cv2.fillPoly(frame, [points], lit_color)
                        
                        # Optional: draw wireframe on top
                        cv2.polylines(frame, [points], True, (0, 0, 0), 1)
        
        return frame
    
    def render_points(self, frame: np.ndarray, vertices: np.ndarray, model_matrix: np.ndarray,
                     color: Tuple[int, int, int] = (255, 255, 0), radius: int = 2) -> np.ndarray:
        """Render vertices as points"""
        if len(vertices) == 0:
            return frame
        
        # Project vertices to screen space
        screen_coords = self.project_vertices(vertices, model_matrix)
        
        # Draw points
        for point in screen_coords:
            if 0 <= point[0] < self.width and 0 <= point[1] < self.height:
                cv2.circle(frame, tuple(point), radius, color, -1)
        
        return frame
    
    def update_camera(self, pos: np.ndarray = None, target: np.ndarray = None):
        """Update camera position and target"""
        if pos is not None:
            self.camera_pos = pos
        if target is not None:
            self.camera_target = target
            
        self.view_matrix = Transform3D.look_at(
            self.camera_pos, self.camera_target, self.camera_up)

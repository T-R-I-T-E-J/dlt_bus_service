# DLT 3D Homepage Experience Specification

## 1. Objective
Create a visually impressive, performance-conscious, scroll-driven journey that communicates the DLT route without sacrificing usability.

## 2. Core Rule
The bus is already on the road when the experience begins and **continues moving on the road throughout the journey**.

## 3. Journey
1. Bus on road
2. Camera pulls back
3. Woxsen approaches
4. Bus slows/stops at Woxsen
5. Woxsen information card
6. Bus resumes
7. Continuous road journey
8. Miyapur approaches
9. Bus slows/stops at Miyapur
10. Destination card
11. Road continues
12. Trip cards emerge
13. Cards transform into booking UI

## 4. Scroll
Scroll controls the scene. Forward and reverse scrolling should reverse/advance the journey.

## 5. Camera
Mostly follow/chase camera, with occasional front/side/aerial cinematic movements, especially at endpoints.

## 6. Environment
Confirmed: realistic environmental details plus a stylized/premium road. Exact environment progression is TBD.

## 7. Stop Cards
Cards appear at meaningful journey moments rather than every section. Woxsen is the start hero; Miyapur is the destination hero.

## 8. Performance
- Optimized 3D assets
- Lazy loading where appropriate
- Efficient textures/lights
- Reduced motion
- Lightweight fallback
- Booking cannot depend on successful 3D rendering

## 9. Mobile
Exact mobile 3D strategy is TBD. The implementation must provide a usable non-3D or reduced 3D fallback.

## 10. Open Visual Decisions
Exact bus model, environment assets, camera curves, lighting, typography and animation timing remain design-stage decisions.

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Helper function to calculate days between dates
function daysBetween(date1, date2) {
    const oneDay = 24 * 60 * 60 * 1000;
    return Math.round(Math.abs((date1 - date2) / oneDay));
}

// Helper function to get time difference in minutes
function minutesDifference(date1, date2) {
    return Math.abs((date1 - date2) / (1000 * 60));
}

// Helper function to format time
function formatTime(date) {
    return new Date(date).toLocaleTimeString('en-US', { 
        hour: '2-digit', 
        minute: '2-digit',
        hour12: true 
    });
}

// API Routes
app.get('/api/wrapped/:canvasUrl/:accessToken', async (req, res) => {
    try {
        const { canvasUrl, accessToken } = req.params;
        const baseUrl = `https://${canvasUrl}`;
        
        console.log('Fetching Canvas Wrapped data...');
        
        // Get courses
        const coursesResponse = await axios.get(`${baseUrl}/api/v1/courses`, {
            params: { access_token: accessToken, per_page: 100 }
        });
        
        // Filter courses created within the last 12 months
        const now = new Date();
        const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 12, now.getDate());
        const courses = coursesResponse.data
            .filter(course => course.course_code && course.created_at && new Date(course.created_at) >= twelveMonthsAgo);

        console.log(`Found ${courses.length} courses from the last 12 months`);
        
        // Get user info
        const userResponse = await axios.get(`${baseUrl}/api/v1/users/self`, {
            params: { access_token: accessToken }
        });
        
        const userId = userResponse.data.id;
        
        // Collect all assignment data
        let allSubmissions = [];
        let allAssignments = [];
        let courseData = {};
        
        for (const course of courses) {
            try {
                // Get assignments for each course
                const assignmentsResponse = await axios.get(`${baseUrl}/api/v1/courses/${course.id}/assignments`, {
                    params: { access_token: accessToken, per_page: 100 }
                });
                
                const assignments = assignmentsResponse.data;
                allAssignments.push(...assignments.map(a => ({ ...a, course_name: course.name, course_code: course.course_code })));
                
                // Get submissions for each assignment
                for (const assignment of assignments) {
                    try {
                        const submissionResponse = await axios.get(`${baseUrl}/api/v1/courses/${course.id}/assignments/${assignment.id}/submissions/${userId}`, {
                            params: { access_token: accessToken }
                        });
                        
                        const submission = submissionResponse.data;
                        if (submission.submitted_at) {
                            allSubmissions.push({
                                ...submission,
                                assignment_name: assignment.name,
                                course_name: course.name,
                                course_code: course.course_code,
                                course_id: course.id,
                                due_at: assignment.due_at,
                                points_possible: assignment.points_possible,
                                unlock_at: assignment.unlock_at
                            });
                        }
                    } catch (err) {
                        console.log(`Could not fetch submission for assignment ${assignment.id}`);
                    }
                }
                
                courseData[course.id] = {
                    name: course.name,
                    code: course.course_code,
                    submissions: allSubmissions.filter(s => s.course_id === course.id)
                };
                
            } catch (err) {
                console.log(`Could not fetch data for course ${course.id}`);
            }
        }
        
        console.log(`Found ${allSubmissions.length} submissions`);
        
        // Calculate metrics
        const metrics = {};
        
        // 1. Living on the Edge - submissions within 10 min of deadline
        const edgeSubmissions = allSubmissions.filter(sub => {
            if (!sub.due_at || !sub.submitted_at) return false;
            const minutesEarly = minutesDifference(new Date(sub.due_at), new Date(sub.submitted_at));
            return minutesEarly <= 10 && new Date(sub.submitted_at) <= new Date(sub.due_at);
        });
        
        metrics.livingOnEdge = {
            count: edgeSubmissions.length,
            caption: "You weren't late, just dangerously close. 🔥",
            examples: edgeSubmissions.slice(0, 3).map(sub => ({
                assignment: sub.assignment_name,
                course: sub.course_code,
                minutesEarly: Math.round(minutesDifference(new Date(sub.due_at), new Date(sub.submitted_at)))
            }))
        };
        
        // 2. Most Procrastinated Class - avg submission lateness by course
        const courseLateness = {};
        Object.values(courseData).forEach(course => {
            const lateSubmissions = course.submissions.filter(sub => 
                sub.due_at && sub.submitted_at && new Date(sub.submitted_at) > new Date(sub.due_at)
            );
            
            if (lateSubmissions.length > 0) {
                const totalLateness = lateSubmissions.reduce((sum, sub) => {
                    return sum + minutesDifference(new Date(sub.submitted_at), new Date(sub.due_at));
                }, 0);
                courseLateness[course.code] = {
                    avgLateness: totalLateness / lateSubmissions.length,
                    lateCount: lateSubmissions.length,
                    name: course.name
                };
            }
        });
        
        const mostProcrastinated = Object.entries(courseLateness)
            .sort(([,a], [,b]) => b.avgLateness - a.avgLateness)[0];
        
        metrics.mostProcrastinated = mostProcrastinated ? {
            course: mostProcrastinated[0],
            avgLateness: Math.round(mostProcrastinated[1].avgLateness),
            lateCount: mostProcrastinated[1].lateCount,
            caption: "Deadlines? You saw them as a challenge. ⌛"
        } : null;
        
        // 3. Most Punctual Class - lowest avg lateness
        const punctualCourses = Object.values(courseData).map(course => {
            const onTimeSubmissions = course.submissions.filter(sub => 
                sub.due_at && sub.submitted_at && new Date(sub.submitted_at) <= new Date(sub.due_at)
            );
            
            return {
                code: course.code,
                name: course.name,
                onTimeCount: onTimeSubmissions.length,
                totalSubmissions: course.submissions.length,
                onTimeRate: course.submissions.length > 0 ? onTimeSubmissions.length / course.submissions.length : 0
            };
        }).filter(c => c.totalSubmissions > 0)
          .sort((a, b) => b.onTimeRate - a.onTimeRate);
        
        metrics.mostPunctual = punctualCourses[0] ? {
            course: punctualCourses[0].code,
            onTimeRate: Math.round(punctualCourses[0].onTimeRate * 100),
            onTimeCount: punctualCourses[0].onTimeCount,
            caption: "You submitted like rent — early and on time. 🕊️"
        } : null;
        
        // 4. Most Assignments Completed
        metrics.mostCompleted = {
            count: allSubmissions.length,
            caption: `You submitted ${allSubmissions.length} things. That's wild. 📤`
        };
        
        // 5. Grade Point Average-ish
        const gradedSubmissions = allSubmissions.filter(sub => sub.score !== null && sub.points_possible > 0);
        if (gradedSubmissions.length > 0) {
            const totalPercent = gradedSubmissions.reduce((sum, sub) => 
                sum + (sub.score / sub.points_possible * 100), 0
            );
            const avgGrade = totalPercent / gradedSubmissions.length;
            
            metrics.gradeAverage = {
                average: Math.round(avgGrade),
                count: gradedSubmissions.length,
                caption: `Solid ${avgGrade >= 90 ? 'A' : avgGrade >= 80 ? 'B' : avgGrade >= 70 ? 'C' : 'effort'} energy. Mostly. 📊`
            };
        }
        
        // 6. Assignment Marathon - most submissions in one day
        const submissionsByDate = {};
        allSubmissions.forEach(sub => {
            const date = new Date(sub.submitted_at).toDateString();
            submissionsByDate[date] = (submissionsByDate[date] || 0) + 1;
        });
        
        const marathonDay = Object.entries(submissionsByDate)
            .sort(([,a], [,b]) => b - a)[0];
        
        metrics.assignmentMarathon = marathonDay ? {
            date: marathonDay[0],
            count: marathonDay[1],
            caption: `You submitted ${marathonDay[1]} things on ${new Date(marathonDay[0]).toLocaleDateString()}. Are you alive? 🏃`
        } : null;
        
        // 7. You at 11:59 PM - histogram of submission times
        const lateNightSubmissions = allSubmissions.filter(sub => {
            const hour = new Date(sub.submitted_at).getHours();
            const minute = new Date(sub.submitted_at).getMinutes();
            return hour === 23 && minute >= 50; // 11:50 PM or later
        });
        
        metrics.lateNightWarrior = {
            count: lateNightSubmissions.length,
            percentage: Math.round((lateNightSubmissions.length / allSubmissions.length) * 100),
            caption: "Why do you love 11:59 PM so much? ⏰"
        };
        
        // 8. Fastest Submission - submitted quickly after assignment opened
        const fastSubmissions = allSubmissions.filter(sub => sub.unlock_at && sub.submitted_at)
            .map(sub => ({
                ...sub,
                minutesAfterUnlock: minutesDifference(new Date(sub.submitted_at), new Date(sub.unlock_at))
            }))
            .filter(sub => new Date(sub.submitted_at) > new Date(sub.unlock_at))
            .sort((a, b) => a.minutesAfterUnlock - b.minutesAfterUnlock);
        
        metrics.fastestSubmission = fastSubmissions[0] ? {
            assignment: fastSubmissions[0].assignment_name,
            course: fastSubmissions[0].course_code,
            minutes: Math.round(fastSubmissions[0].minutesAfterUnlock),
            caption: `You submitted ${Math.round(fastSubmissions[0].minutesAfterUnlock)} minutes after the assignment opened. ⚡`
        } : null;
        
        // 9. Model Student - no late submissions
        const lateSubmissions = allSubmissions.filter(sub => 
            sub.due_at && sub.submitted_at && new Date(sub.submitted_at) > new Date(sub.due_at)
        );
        
        metrics.modelStudent = {
            isModel: lateSubmissions.length === 0 && allSubmissions.length > 5,
            lateCount: lateSubmissions.length,
            caption: lateSubmissions.length === 0 ? "You didn't miss anything. Are you okay?? 😇" : `Only ${lateSubmissions.length} late submissions. Not bad! 📚`
        };
        
        // 10. Comeback Arc - grade improvement
        const timeOrderedGrades = gradedSubmissions
            .sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at))
            .map(sub => sub.score / sub.points_possible * 100);
        
        if (timeOrderedGrades.length >= 5) {
            const firstQuarter = timeOrderedGrades.slice(0, Math.floor(timeOrderedGrades.length / 4));
            const lastQuarter = timeOrderedGrades.slice(-Math.floor(timeOrderedGrades.length / 4));
            
            const firstAvg = firstQuarter.reduce((a, b) => a + b, 0) / firstQuarter.length;
            const lastAvg = lastQuarter.reduce((a, b) => a + b, 0) / lastQuarter.length;
            
            metrics.comebackArc = {
                improvement: Math.round(lastAvg - firstAvg),
                startGrade: Math.round(firstAvg),
                endGrade: Math.round(lastAvg),
                caption: lastAvg > firstAvg ? 
                    `Started from a ${Math.round(firstAvg)}. Finished at a ${Math.round(lastAvg)}. Character growth. 📈` :
                    `Consistent performer. Steady as they go! 📊`
            };
        }
        
        // 11. Lowest Grade Assignment
        let lowestGradeAssignment = null;
        if (gradedSubmissions.length > 0) {
            lowestGradeAssignment = gradedSubmissions.reduce((min, sub) => {
                const percent = sub.score / sub.points_possible;
                if (!min || percent < min.percent) {
                    return {
                        name: sub.assignment_name,
                        course: sub.course_code,
                        percent: percent,
                        score: sub.score,
                        points_possible: sub.points_possible
                    };
                }
                return min;
            }, null);

            metrics.lowestGrade = {
                name: lowestGradeAssignment.name,
                course: lowestGradeAssignment.course,
                percent: Math.round(lowestGradeAssignment.percent * 100),
                caption: `Lowest grade: ${Math.round(lowestGradeAssignment.percent * 100)}% on "${lowestGradeAssignment.name}"`
            };
        }

        let result = {
            success: true,
            user: userResponse.data.name,
            courses: courses,
            totalCourses: courses.length,
            totalSubmissions: allSubmissions.length,
            metrics
        }

        console.log(result);
        
        res.json(result);
        
    } catch (error) {
        console.error('Error fetching Canvas data:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Canvas Wrapped server running on port ${PORT}`);
});
# Generated by Django 2.2.13 on 2021-02-08 10:31

from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('numbas_lti', '0061_exam_static_uuid'),
    ]

    operations = [
        migrations.AddField(
            model_name='scormelement',
            name='diff_of',
            field=models.ForeignKey(default=None, null=True, on_delete=django.db.models.deletion.PROTECT, to='numbas_lti.ScormElement'),
        ),
    ]